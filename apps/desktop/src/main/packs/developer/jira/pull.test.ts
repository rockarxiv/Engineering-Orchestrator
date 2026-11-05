import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jiraStateOf, acceptanceCriteriaOf, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import {
  deleteJiraBinding,
  getItemByKey,
  isJiraPullPending,
  linkJiraKey,
  listAttachmentsForItem,
  listCommentsForItem,
  getItem,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  setJiraSync,
  updateItem,
  type Workspace,
} from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { submitPlan } from "../../../ipc/planCommands.js";
import { AttachmentStorage } from "../../../attachments/storage.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { FetchLike } from "./client.js";
import type { JiraContext } from "./connection.js";
import { storeToken } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";
import { drainChannel } from "../../../outbox/drain.js";
import { pullEverything, pullPending, pullItem } from "./pull.js";
import { createJiraSender } from "./sender.js";

/**
 * Pulling what Jira knows back into EO.
 *
 * The direction that did not exist: EO pushed comments and status out,
 * and an import copied an issue in exactly once, so anything written in
 * Jira afterwards never arrived.
 *
 * Every test here drives the real client through the injected
 * `fetchImpl` seam — the same one `client.test.ts` uses — so nothing
 * mocks a module and the v2/v3 request shapes are exercised for real.
 */
let handle: DbHandle;
let directory: string;
let workspace: Workspace;
/** The project the workspace came with, and since KAN-130 the holder of the Jira binding. */
let projectId: Uuid;
let item: Item;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

interface RemoteIssue {
  summary?: string;
  description?: string;
  comments?: { id: string; body: string; author?: { name?: string }; created?: string }[];
}

/** A Data Center Jira holding one issue. Plain-text bodies, so no ADF in the way of the assertion. */
function jiraHolding(issue: RemoteIssue): { fetchImpl: FetchLike; posted: string[] } {
  const posted: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;

    if (path.endsWith("/comment") && init?.method === "POST") {
      posted.push(String(JSON.parse(String(init.body)).body));
      return json({ id: `new-${posted.length}` }, 201);
    }
    if (path.endsWith("/comment")) {
      return json({ comments: issue.comments ?? [], total: (issue.comments ?? []).length });
    }
    if (path.includes("/search")) {
      return json({ issues: [{ id: "10002", key: "ACME-8", fields: { summary: issue.summary ?? "Count requests", updated: "2026-08-09T10:00:00Z" } }] });
    }
    return json({
      id: "10002",
      key: "ACME-8",
      fields: { summary: issue.summary ?? "Count requests", description: issue.description ?? "", updated: "2026-08-09T10:00:00Z" },
    });
  };
  return { fetchImpl, posted };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

function connect(): void {
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  saveJiraBinding(handle.db, projectId, { connectionId: site.id, projectKey: "ACME" });
  storeToken({ directory, store }, site.id, "pat");
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo pull creds "));
  workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
  projectId = projectForWorkspace(handle.db, workspace.id)!.id;
  item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id, projectId, body: "Count them." });
  updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
  connect();
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the echo loop", () => {
  it("does not re-import a comment EO itself wrote and pushed", async () => {
    // The failure this whole design exists to prevent. EO writes a
    // comment, pushes it, Jira assigns it an id — and on the next pull
    // Jira offers that same comment back. Without the id recorded on
    // the push there is nothing to recognise it by, so EO imports its
    // own words, which queues them to Jira again, which the next pull
    // reads... unbounded, with "— via EO" accreting each cycle.
    const mine = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Cap it at 100." });
    const jira = jiraHolding({ comments: [] });
    await drainChannel(handle.db, "jira", createJiraSender(context(jira.fetchImpl)));

    const jiraId = listCommentsForItem(handle.db, item.id).find((entry) => entry.id === mine.id)?.jiraCommentId;
    expect(jiraId, "the push must record which Jira comment it became").not.toBeNull();

    // Now Jira offers it back, exactly as it would.
    const echo = jiraHolding({ comments: [{ id: jiraId!, body: "Cap it at 100.\n\n— via EO", author: { name: "EO" } }] });
    const result = await pullItem(handle.db, context(echo.fetchImpl), item.id);

    expect(result.comments).toBe(0);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
    // The assertion that matters: nothing was queued back to Jira.
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });

  it("does not send a pulled comment back to the issue it came from", async () => {
    const jira = jiraHolding({ comments: [{ id: "10501", body: "Per API key.", author: { name: "Dana" } }] });

    await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
    expect(pendingPushesForItem(handle.db, item.id), "a pulled comment must never be queued outbound").toEqual([]);
  });

  it("keeps sending comments that really are EO's", async () => {
    // The negative half: the guard must not have turned the mirror off.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Ours." });

    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(1);
  });
});

describe("pulling comments", () => {
  it("brings in one EO has never seen, naming who wrote it", async () => {
    const jira = jiraHolding({ comments: [{ id: "10501", body: "Per API key, not per account.", author: { name: "Dana" } }] });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result).toMatchObject({ comments: 1, problem: null });
    const comment = listCommentsForItem(handle.db, item.id)[0];
    expect(comment?.body).toContain("Per API key, not per account.");
    expect(comment?.body).toContain("Dana");
    expect(comment?.jiraCommentId).toBe("10501");
  });

  it("does not duplicate it on the next pull", async () => {
    const jira = jiraHolding({ comments: [{ id: "10501", body: "Per API key.", author: { name: "Dana" } }] });

    await pullItem(handle.db, context(jira.fetchImpl), item.id);
    const second = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(second.comments).toBe(0);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("brings in only what is new when the thread has grown", async () => {
    const first = jiraHolding({ comments: [{ id: "1", body: "One.", author: { name: "Dana" } }] });
    await pullItem(handle.db, context(first.fetchImpl), item.id);

    const grown = jiraHolding({
      comments: [
        { id: "1", body: "One.", author: { name: "Dana" } },
        { id: "2", body: "Two.", author: { name: "Sam" } },
      ],
    });
    const result = await pullItem(handle.db, context(grown.fetchImpl), item.id);

    expect(result.comments).toBe(1);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(2);
  });
});

describe("pulling edits", () => {
  it("takes a corrected summary and says what it replaced", async () => {
    // Jira wins, but never silently — a local edit made between syncs
    // has to be recoverable by reading the thread.
    const jira = jiraHolding({ summary: "Count requests per API key" });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(1);
    expect(getItem(handle.db, item.id)?.title).toBe("Count requests per API key");
    const note = listCommentsForItem(handle.db, item.id).find((entry) => entry.authorType === "engine");
    expect(note?.body).toContain("Count requests");
    expect(note?.body).toContain("ACME-8");
  });

  it("takes a corrected description too", async () => {
    const jira = jiraHolding({ description: "Count them, per key, over a sliding window." });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(1);
    expect(getItem(handle.db, item.id)?.body).toBe("Count them, per key, over a sliding window.");
  });

  it("says nothing when nothing changed", async () => {
    const jira = jiraHolding({ summary: "Count requests", description: "Count them." });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(0);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("does not call a story's own acceptance criteria an edit made in Jira", async () => {
    // EO writes a story's criteria into the description it creates, so
    // the description Jira hands back is the body *plus* them. Comparing
    // that to `body` alone made every sync look like a Jira edit — and
    // "applying" it copied the criteria into the body, where the item
    // screen showed them twice.
    updateItem(handle.db, item.id, { spec: { acceptance_criteria: ["429 after 100 req/min"] } });
    const jira = jiraHolding({ description: "Count them.\n\nAcceptance criteria:\n- 429 after 100 req/min" });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(0);
    expect(getItem(handle.db, item.id)?.body).toBe("Count them.");
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("repairs a body an earlier sync had already doubled up", async () => {
    // What the bug left behind. The criteria are in `body` as prose and
    // in `spec` as the list they came from; the next sync now puts the
    // body back to what Jira actually has above the block.
    updateItem(handle.db, item.id, {
      body: "Count them.\n\nAcceptance criteria:\n- 429 after 100 req/min",
      spec: { acceptance_criteria: ["429 after 100 req/min"] },
    });
    const jira = jiraHolding({ description: "Count them.\n\nAcceptance criteria:\n- 429 after 100 req/min" });

    await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(getItem(handle.db, item.id)?.body).toBe("Count them.");
    expect(acceptanceCriteriaOf(getItem(handle.db, item.id)!)).toEqual(["429 after 100 req/min"]);
  });

  it("takes a description edited above the criteria without disturbing them", async () => {
    updateItem(handle.db, item.id, { spec: { acceptance_criteria: ["429 after 100 req/min"] } });
    const jira = jiraHolding({ description: "Count them, per key.\n\nAcceptance criteria:\n- 429 after 100 req/min" });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(1);
    const updated = getItem(handle.db, item.id)!;
    expect(updated.body).toBe("Count them, per key.");
    expect(acceptanceCriteriaOf(updated)).toEqual(["429 after 100 req/min"]);
  });

  it("takes criteria edited in Jira, keeping the rest of the spec and saying what they were", async () => {
    updateItem(handle.db, item.id, {
      spec: { acceptance_criteria: ["429 after 100 req/min"], touches: ["src/api.ts"] },
    });
    const jira = jiraHolding({ description: "Count them.\n\nAcceptance criteria:\n- 429 after 60 req/min\n- Retry-After is set" });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(1);
    const updated = getItem(handle.db, item.id)!;
    expect(acceptanceCriteriaOf(updated)).toEqual(["429 after 60 req/min", "Retry-After is set"]);
    expect(updated.spec?.["touches"]).toEqual(["src/api.ts"]); // the rest of the spec is not collateral
    expect(updated.body).toBe("Count them."); // and the body is still the body
    const note = listCommentsForItem(handle.db, item.id).find((entry) => entry.authorType === "engine");
    expect(note?.body).toContain("429 after 100 req/min"); // what it replaced, recoverable by reading
  });

  it("settles, rather than re-reporting the same criteria edit every few minutes", async () => {
    updateItem(handle.db, item.id, { spec: { acceptance_criteria: ["429 after 100 req/min"] } });
    const jira = jiraHolding({ description: "Count them.\n\nAcceptance criteria:\n- 429 after 60 req/min" });

    await pullItem(handle.db, context(jira.fetchImpl), item.id);
    const second = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(second.edits).toBe(0);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("does not drop the definition of done because someone deleted the section in Jira", async () => {
    updateItem(handle.db, item.id, { spec: { acceptance_criteria: ["429 after 100 req/min"] } });
    const jira = jiraHolding({ description: "Count them." });

    const result = await pullItem(handle.db, context(jira.fetchImpl), item.id);

    expect(result.edits).toBe(0);
    expect(acceptanceCriteriaOf(getItem(handle.db, item.id)!)).toEqual(["429 after 100 req/min"]);
  });

  it("does not give a feature a body it was never meant to have", async () => {
    // A feature's description became its opening comment at import, on
    // purpose. Filling `body` here would hand the product owner the same
    // words twice and undo a deliberate decision.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: workspace.id,
      projectId });
    updateItem(handle.db, feature.id, { jiraKey: "ACME-7" });
    const jira = jiraHolding({ description: "Throttle the public API." });

    await pullItem(handle.db, context(jira.fetchImpl), feature.id);

    expect(getItem(handle.db, feature.id)?.body).toBeNull();
  });
});

describe("a feature and its stories", () => {
  it("pulls the stories too, because that is what syncing a feature means", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: workspace.id,
      projectId });
    updateItem(handle.db, feature.id, { jiraKey: "ACME-7" });
    const story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: workspace.id,
      projectId, parentId: feature.id });
    updateItem(handle.db, story.id, { jiraKey: "ACME-9" });
    // Each issue has its own comment, as two real issues would — a
    // shared id would be correctly deduplicated and prove nothing.
    const perIssue: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const key = /\/issue\/([^/]+)/.exec(path)?.[1] ?? "";
      if (path.endsWith("/comment")) {
        return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
      }
      return json({ id: "1", key, fields: { summary: "unchanged", updated: "x" } });
    };

    const result = await pullItem(handle.db, context(perIssue), feature.id);

    // One for the feature, one for its story.
    expect(result.comments).toBe(2);
    // The pulled ones specifically — reconciling the fake's summary also
    // leaves an engine note, which is correct and not what this is about.
    const pulled = (id: Item["id"]) => listCommentsForItem(handle.db, id).filter((entry) => entry.jiraCommentId !== null);
    expect(pulled(story.id)).toHaveLength(1);
    expect(pulled(feature.id)).toHaveLength(1);
  });
});

/**
 * The switch gates the way in as well as the way out (EO-122).
 *
 * An item with sync off is invisible to Jira in both directions. Pull
 * is the half that is easy to forget, because nothing about it is
 * initiated by the item — the timer sweeps a whole project — so a
 * silenced item would otherwise go on quietly taking edits and
 * comments from an issue it is meant to have nothing to do with.
 */
describe("the Jira sync switch", () => {
  /** Records every path asked for, so "left alone" can mean "not even asked about". */
  function watching(inner: FetchLike): { fetchImpl: FetchLike; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      fetchImpl: async (url, init) => {
        paths.push(new URL(url).pathname);
        return inner(url, init);
      },
    };
  }

  it("leaves a sync-disabled item alone, and says why rather than reporting a clean nothing", async () => {
    setJiraSync(handle.db, item.id, false);
    const watcher = watching(jiraHolding({ summary: "Renamed in Jira", comments: [{ id: "c-1", body: "A note.", author: { name: "Dana" } }] }).fetchImpl);

    const result = await pullItem(handle.db, context(watcher.fetchImpl), item.id);

    expect(result).toMatchObject({ comments: 0, edits: 0 });
    expect(result.problem).toContain("switched off");
    // Not one request: the gate is before the connection is even resolved.
    expect(watcher.paths).toEqual([]);
    expect(getItem(handle.db, item.id)?.title).toBe("Count requests");
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("skips a feature's sync-disabled child while its siblings still pull", async () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: workspace.id,
      projectId });
    updateItem(handle.db, feature.id, { jiraKey: "ACME-7" });
    const quiet = createTestItem(handle.db, { type: "story", title: "Silenced", stepId: "todo", workspaceId: workspace.id,
      projectId, parentId: feature.id });
    updateItem(handle.db, quiet.id, { jiraKey: "ACME-9" });
    setJiraSync(handle.db, quiet.id, false);
    const loud = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: workspace.id,
      projectId, parentId: feature.id });
    updateItem(handle.db, loud.id, { jiraKey: "ACME-10" });

    const perIssue: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const key = /\/issue\/([^/]+)/.exec(path)?.[1] ?? "";
      if (path.endsWith("/comment")) return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
      return json({ id: "1", key, fields: { summary: "unchanged", updated: "x" } });
    };
    const watcher = watching(perIssue);

    const result = await pullItem(handle.db, context(watcher.fetchImpl), feature.id);

    // The feature and the one sibling, and nothing for the silenced one.
    expect(result.comments).toBe(2);
    const pulled = (id: Item["id"]) => listCommentsForItem(handle.db, id).filter((entry) => entry.jiraCommentId !== null);
    expect(pulled(feature.id)).toHaveLength(1);
    expect(pulled(loud.id)).toHaveLength(1);
    expect(pulled(quiet.id)).toEqual([]);
    expect(watcher.paths.some((path) => path.includes("ACME-9"))).toBe(false);
    // One silenced child does not make its siblings a problem to report.
    expect(result.problem).toBeNull();
  });

  it("leaves a sync-disabled item out of the project sweep, even when Jira says its issue moved", async () => {
    // The issue really has changed — the fake's search returns it — so
    // the only thing keeping it out is the switch.
    setJiraSync(handle.db, item.id, false);
    const watcher = watching(jiraHolding({ summary: "Renamed in Jira", comments: [{ id: "c-1", body: "A note.", author: { name: "Dana" } }] }).fetchImpl);

    const result = await pullEverything(handle.db, context(watcher.fetchImpl), 5);

    expect(result).toMatchObject({ comments: 0, edits: 0, problem: null });
    expect(getItem(handle.db, item.id)?.title).toBe("Count requests");
    // With nothing left to mirror there is no reason even to search.
    expect(watcher.paths).toEqual([]);
  });

  it("resumes against the same issue when sync is switched back on", async () => {
    // The point of a switch that is not the key.
    setJiraSync(handle.db, item.id, false);
    const jira = jiraHolding({ comments: [{ id: "c-1", body: "A note.", author: { name: "Dana" } }] });
    expect((await pullEverything(handle.db, context(jira.fetchImpl), 5)).comments).toBe(0);

    setJiraSync(handle.db, item.id, true);

    expect((await pullEverything(handle.db, context(jira.fetchImpl), 5)).comments).toBe(1);
  });
});

describe("when it cannot ask", () => {
  it("reports an item that is not mirrored rather than throwing", async () => {
    const plain = createTestItem(handle.db, { type: "story", title: "Local only", stepId: "todo", workspaceId: workspace.id,
      projectId });

    const result = await pullItem(handle.db, context(jiraHolding({}).fetchImpl), plain.id);

    expect(result.problem).toContain("not mirrored");
  });

  it("reports a project that is not connected", async () => {
    saveJiraBinding(handle.db, projectId, { projectKey: null });

    const result = await pullItem(handle.db, context(jiraHolding({}).fetchImpl), item.id);

    expect(result.problem).toContain("not connected");
  });

  it("reports what Jira said rather than letting it escape", async () => {
    const refusing: FetchLike = async () => json({ errorMessages: ["Jira has no such thing"] }, 404);

    const result = await pullItem(handle.db, context(refusing), item.id);

    expect(result.problem).toContain("ACME-8");
    expect(result.comments).toBe(0);
  });

  it("reports an item that is gone", async () => {
    const result = await pullItem(handle.db, context(jiraHolding({}).fetchImpl), "01890000-0000-7000-8000-000000000000" as Item["id"]);

    expect(result.problem).toContain("no longer exists");
  });
});

describe("sweeping every connected project", () => {
  it("asks Jira which issues moved rather than every item in turn", async () => {
    // Forty stories should be one request, not forty.
    const urls: string[] = [];
    const jira = jiraHolding({ comments: [{ id: "10501", body: "A note.", author: { name: "Dana" } }] });
    const counting: FetchLike = async (url, init) => {
      urls.push(new URL(url).pathname);
      return jira.fetchImpl(url, init);
    };

    const result = await pullEverything(handle.db, context(counting), 5);

    expect(result.comments).toBe(1);
    expect(urls.filter((path) => path.includes("/search"))).toHaveLength(1);
  });

  it("ignores an issue in the same Jira project that EO does not mirror", async () => {
    const strangers: FetchLike = async (url) => {
      if (new URL(url).pathname.includes("/search")) {
        return json({ issues: [{ id: "999", key: "ACME-999", fields: { summary: "Someone else's", updated: "x" } }] });
      }
      return json({});
    };

    const result = await pullEverything(handle.db, context(strangers), 5);

    expect(result).toMatchObject({ comments: 0, edits: 0, problem: null });
  });

  it("does nothing at all when no project is connected", async () => {
    deleteJiraBinding(handle.db, projectId);

    expect(await pullEverything(handle.db, context(jiraHolding({}).fetchImpl), 5)).toEqual({
      comments: 0,
      edits: 0,
      attachments: 0,
      skippedAttachments: 0,
      problem: null,
    });
  });
});

/**
 * The items somebody attached to an issue since the last tick (EO-127).
 *
 * Attaching is a local write on a synchronous path — `work_submit_ticket`,
 * `work_submit_plan`, `ticket_update` — so it records the intent and
 * this is what acts on it. It exists as its own pass because the
 * ordinary sweep cannot see these: `pullProject` asks Jira which issues
 * *moved* recently, and an issue nobody has touched this week never
 * appears in that answer however long you wait.
 */
describe("draining the items attached since the last tick", () => {
  beforeEach(() => {
    // One issue is one item, and the suite's shared item already
    // holds ACME-8. These tests attach their own, so it lets go first.
    linkJiraKey(handle.db, item.id, null);
  });

  /** Attaches through the front door, which is what sets the marker. */
  function attach(itemId: Item["id"], key: string): void {
    const linked = linkJiraKey(handle.db, itemId, key);
    expect(linked.ok).toBe(true);
  }

  /** An item that arrived unlinked, so attaching it is a real attach. */
  function unlinked(title: string, overrides: { parentId?: Item["id"]; type?: string } = {}): Item {
    return createTestItem(handle.db, {
      type: overrides.type ?? "story",
      title,
      stepId: overrides.type === "feature" ? null : "todo",
      workspaceId: workspace.id,
      projectId,
      body: "Whatever EO was told.",
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
    });
  }

  it("pulls an item by name and clears its marker", async () => {
    const subject = unlinked("Count requests");
    attach(subject.id, "ACME-8");
    const jira = jiraHolding({ comments: [{ id: "10501", body: "Dana's note.", author: { name: "Dana" } }] });

    const result = await pullPending(handle.db, context(jira.fetchImpl));

    expect(result.comments).toBe(1);
    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  it("does nothing, and asks nothing, when no item is waiting", async () => {
    // The ordinary tick. The drain runs every minute, so a project with
    // nothing attached must cost no requests at all.
    let asked = 0;
    const counting: FetchLike = async (url, init) => {
      asked += 1;
      return jiraHolding({}).fetchImpl(url, init);
    };

    expect(await pullPending(handle.db, context(counting))).toMatchObject({ comments: 0, edits: 0, problem: null });
    expect(asked).toBe(0);
  });

  it("leaves the marker set when Jira cannot be reached, and pulls it on the next attempt", async () => {
    // The whole reason the marker exists rather than a call at attach
    // time: an attach made while Jira is down must not lose its
    // backfill, and nothing else will ever come back for this issue.
    const subject = unlinked("Count requests");
    attach(subject.id, "ACME-8");
    const offline: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND jira.acme.internal");
    };

    const failed = await pullPending(handle.db, context(offline));

    expect(failed.problem).toContain("ACME-8");
    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);

    const jira = jiraHolding({ comments: [{ id: "10501", body: "Dana's note.", author: { name: "Dana" } }] });
    const retried = await pullPending(handle.db, context(jira.fetchImpl));

    expect(retried.comments).toBe(1);
    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  it("brings the issue's title, description and acceptance criteria across, with what they replaced in the thread", async () => {
    // `reconcileFields` as it already behaves, and this story invents no
    // exception to it: from the moment two things are agreed to be the
    // same issue, the shared artefact is the one other people read and
    // edit. What was replaced goes into the thread, so a title somebody
    // wrote in EO a minute ago is recoverable by reading.
    const subject = unlinked("What EO was told");
    updateItem(handle.db, subject.id, { spec: { acceptance_criteria: ["EO's own criterion"] } });
    attach(subject.id, "ACME-8");
    const jira = jiraHolding({
      summary: "What Jira says",
      description: "The issue as everyone else reads it.\n\nAcceptance criteria:\n- Jira's criterion",
    });

    await pullPending(handle.db, context(jira.fetchImpl));

    const after = getItem(handle.db, subject.id)!;
    expect(after.title).toBe("What Jira says");
    expect(after.body).toContain("The issue as everyone else reads it.");
    expect(acceptanceCriteriaOf(after)).toEqual(["Jira's criterion"]);
    const note = listCommentsForItem(handle.db, subject.id).map((entry) => entry.body).join("\n");
    expect(note).toContain("What EO was told");
    expect(note).toContain("EO's own criterion");
  });

  it("brings the issue's attachments across", async () => {
    const storage = new AttachmentStorage(join(directory, "files"));
    const subject = unlinked("Count requests");
    attach(subject.id, "ACME-8");
    const withFile: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/comment")) return json({ comments: [], total: 0 });
      if (path.endsWith("/content/remote-1")) return new Response(Buffer.from("hello"), { status: 200 });
      return json({
        id: "10002",
        key: "ACME-8",
        fields: {
          summary: "Count requests",
          description: "",
          updated: "x",
          attachment: [{ id: "remote-1", filename: "spec.txt", mimeType: "text/plain", size: 5, content: "https://jira.acme.internal/content/remote-1" }],
        },
      });
    };

    const result = await pullPending(handle.db, context(withFile), storage);

    expect(result.attachments).toBe(1);
    expect(listAttachmentsForItem(handle.db, subject.id).map((entry) => entry.name)).toEqual(["spec.txt"]);
    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  it("does not import back a comment EO wrote and pushed to that issue", async () => {
    // The echo loop, at the one moment it is easiest to fall into: a
    // item that has been talking to Jira, detached and attached again,
    // whose own words are sitting on the issue with ids EO recorded.
    const subject = unlinked("Count requests");
    attach(subject.id, "ACME-8");
    const mine = postComment(handle.db, { itemId: subject.id, author: { type: "human" }, body: "Cap it at 100." });
    const jira = jiraHolding({ comments: [] });
    await drainChannel(handle.db, "jira", createJiraSender(context(jira.fetchImpl)));
    const pushedId = listCommentsForItem(handle.db, subject.id).find((entry) => entry.id === mine.id)?.jiraCommentId;
    expect(pushedId).not.toBeNull();

    const echoing = jiraHolding({ comments: [{ id: String(pushedId), body: "Cap it at 100.", author: { name: "Dana" } }] });
    const result = await pullPending(handle.db, context(echoing.fetchImpl));

    expect(result.comments).toBe(0);
    expect(listCommentsForItem(handle.db, subject.id).filter((entry) => entry.body.includes("Cap it at 100."))).toHaveLength(1);
  });

  it("pulls a feature's already-attached children with it", async () => {
    // `pullItem` is what the drain runs, so "this feature" means the
    // same here as it does when somebody asks for a pull by hand.
    const feature = unlinked("Rate limiting", { type: "feature" });
    const child = unlinked("The limiter", { parentId: feature.id });
    attach(child.id, "ACME-9");
    // The child's own marker is drained first; clearing it is what makes
    // the next assertion about the feature's pull and not about it.
    const perIssue: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const key = /\/issue\/([^/]+)/.exec(path)?.[1] ?? "";
      if (path.endsWith("/comment")) return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
      return json({ id: "1", key, fields: { summary: "unchanged", updated: "x" } });
    };
    await pullPending(handle.db, context(perIssue));

    attach(feature.id, "ACME-7");
    const result = await pullPending(handle.db, context(perIssue));

    // Two issues read for one marker: the feature's, and the story's
    // underneath it. The story's comment is already known by its id, so
    // only the feature's is new.
    expect(result.comments).toBe(1);
    expect(listCommentsForItem(handle.db, feature.id).filter((entry) => entry.jiraCommentId === "c-ACME-7")).toHaveLength(1);
  });

  it("drains every waiting item, not only the first", async () => {
    const first = unlinked("Count requests");
    const second = unlinked("Count them again");
    attach(first.id, "ACME-8");
    attach(second.id, "ACME-9");
    const perIssue: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const key = /\/issue\/([^/]+)/.exec(path)?.[1] ?? "";
      if (path.endsWith("/comment")) return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
      return json({ id: "1", key, fields: { summary: "unchanged", updated: "x" } });
    };

    const result = await pullPending(handle.db, context(perIssue));

    expect(result.comments).toBe(2);
    expect(isJiraPullPending(handle.db, first.id)).toBe(false);
    expect(isJiraPullPending(handle.db, second.id)).toBe(false);
  });

  it("waits quietly for a project that has no Jira connected yet", async () => {
    // Not a failure to announce once a minute for the rest of the
    // session: `pullItem` would refuse this locally and hand back a
    // sentence, and the schedule logs every sentence it gets. The marker
    // waits, and the pull happens on the first tick after somebody
    // connects the project.
    deleteJiraBinding(handle.db, projectId);
    const subject = unlinked("Count requests");
    attach(subject.id, "ACME-8");

    expect(await pullPending(handle.db, context(jiraHolding({}).fetchImpl))).toMatchObject({ problem: null });
    expect(isJiraPullPending(handle.db, subject.id)).toBe(true);

    connect();
    await pullPending(handle.db, context(jiraHolding({}).fetchImpl));

    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
  });

  /**
   * Relinking while the old issue is being read.
   *
   * A pull is several network round trips, and EO's write handlers —
   * `ticket_update`, the rail's attach box — run in the gaps between
   * them. Without a guard the finishing pull writes KAN-1's comments,
   * title and description onto an item that now mirrors KAN-2, and then
   * clears KAN-2's brand-new marker. KAN-2 would never be read at all:
   * the ordinary sweep asks Jira what *moved*, and an issue somebody
   * just attached has not moved.
   */
  describe("when the item is relinked mid-pull", () => {
    /** Answers for whichever issue is asked for, running `interrupt` once, mid-flight. */
    function interrupting(interrupt: () => void, on: "issue" | "comments"): FetchLike {
      let fired = false;
      const run = (when: "issue" | "comments"): void => {
        if (fired || when !== on) return;
        fired = true;
        interrupt();
      };
      return async (url) => {
        const path = new URL(url).pathname;
        const key = /\/issue\/([^/?]+)/.exec(path)?.[1] ?? "";
        if (path.endsWith("/comment")) {
          run("comments");
          return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
        }
        run("issue");
        return json({ id: "1", key, fields: { summary: `${key}'s summary`, description: `${key}'s description`, updated: "x" } });
      };
    }

    /** An issue holding one downloadable file, running `duringDownload` while it is fetched. */
    function withOneFile(duringDownload: () => void = () => {}): FetchLike {
      return async (url) => {
        const path = new URL(url).pathname;
        const key = /\/issue\/([^/?]+)/.exec(path)?.[1] ?? "";
        if (path.endsWith("/comment")) return json({ comments: [], total: 0 });
        if (path.endsWith("/content/remote-1")) {
          duringDownload();
          return new Response(Buffer.from("hello"), { status: 200 });
        }
        return json({
          id: "10002",
          key,
          fields: {
            summary: `${key}'s summary`,
            description: "",
            updated: "x",
            attachment: [{ id: "remote-1", filename: "spec.txt", mimeType: "text/plain", size: 5, content: "https://jira.acme.internal/content/remote-1" }],
          },
        });
      };
    }

    it("applies nothing from the old issue, and keeps the new issue's marker", async () => {
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");
      // Between reading ACME-8's fields and writing them: exactly where
      // somebody clicking Attach in the rail lands.
      const fetchImpl = interrupting(() => {
        expect(linkJiraKey(handle.db, subject.id, "ACME-9").ok).toBe(true);
      }, "comments");

      const result = await pullPending(handle.db, context(fetchImpl));

      // Nothing from ACME-8 reached the item: not its comment, not its
      // summary, not its description.
      const after = getItem(handle.db, subject.id)!;
      expect(after.title).toBe("What EO was told");
      expect(after.body).toBe("Whatever EO was told.");
      expect(listCommentsForItem(handle.db, subject.id)).toEqual([]);
      // And the marker ACME-9 arrived with is still there to be drained.
      expect(jiraStateOf(after).key).toBe("ACME-9");
      expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
      expect(result.problem).toContain("stopped mirroring ACME-8");
    });

    it("reads the new issue on the next drain", async () => {
      // The half that makes the guard worth having: the backfill is
      // deferred, not lost.
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");
      await pullPending(
        handle.db,
        context(
          interrupting(() => {
            linkJiraKey(handle.db, subject.id, "ACME-9");
          }, "comments"),
        ),
      );

      const result = await pullPending(handle.db, context(interrupting(() => {}, "issue")));

      expect(result.comments).toBe(1);
      expect(getItem(handle.db, subject.id)?.title).toBe("ACME-9's summary");
      expect(listCommentsForItem(handle.db, subject.id).some((entry) => entry.jiraCommentId === "c-ACME-9")).toBe(true);
      expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
    });

    it("stops before it has even asked for the comments, when the relink lands first", async () => {
      // The earlier gap — between `getIssue` and everything after it.
      // Nothing is fetched for an issue this item has already left.
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");
      const asked: string[] = [];
      const watched: FetchLike = async (url, init) => {
        asked.push(new URL(url).pathname);
        return interrupting(() => {
          linkJiraKey(handle.db, subject.id, "ACME-9");
        }, "issue")(url, init);
      };

      await pullPending(handle.db, context(watched));

      expect(asked.filter((path) => path.endsWith("/comment"))).toEqual([]);
      expect(getItem(handle.db, subject.id)?.title).toBe("What EO was told");
      expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
    });

    it("applies nothing to an item silenced mid-pull", async () => {
      // The switch is half of the link (EO-122): an item somebody just
      // silenced must not take that issue's words a second later, for
      // the same reason it would not have been read at all had the
      // switch been off a moment earlier.
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");
      const fetchImpl = interrupting(() => {
        setJiraSync(handle.db, subject.id, false);
      }, "comments");

      await pullPending(handle.db, context(fetchImpl));

      expect(getItem(handle.db, subject.id)?.title).toBe("What EO was told");
      expect(listCommentsForItem(handle.db, subject.id)).toEqual([]);
      // `setJiraSync(false)` dropped the marker itself; the guarded
      // clear has nothing to do either way.
      expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
    });

    it("stops deleting the old issue's files the moment the item is relinked", async () => {
      // Deletion is the half that destroys rather than adds, and
      // relinking does not discard an item's attachment rows — the
      // files stay, which is the point of keeping them. So a deletion
      // loop that carried on past a relink would remove the *new*
      // issue's item's data on the authority of the *old* issue's
      // listing, and nothing would be left to say what went.
      const storageRoot = join(directory, "files");
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");

      // Two real files on ACME-8 first, so each has a managed file on
      // disk and a remote id for a later listing to miss.
      let listing = [
        { id: "remote-1", filename: "first.txt", mimeType: "text/plain", size: 5, content: "https://jira.acme.internal/content/remote-1" },
        { id: "remote-2", filename: "second.txt", mimeType: "text/plain", size: 5, content: "https://jira.acme.internal/content/remote-2" },
      ];
      const jira: FetchLike = async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/comment")) return json({ comments: [], total: 0 });
        if (path.includes("/content/")) return new Response(Buffer.from("hello"), { status: 200 });
        // The summary matches the item, so nothing here is about
        // field reconciliation.
        return json({ id: "10002", key: "ACME-8", fields: { summary: "What EO was told", description: "", updated: "x", attachment: listing } });
      };
      await pullItem(handle.db, context(jira), subject.id, new AttachmentStorage(storageRoot));
      const before = listAttachmentsForItem(handle.db, subject.id);
      expect(before).toHaveLength(2);

      // Now ACME-8 has neither, so both are stale by that listing — and
      // the relink lands while the first is being removed.
      listing = [];
      class RelinkingOnRemove extends AttachmentStorage {
        override async removeManaged(attachment: Parameters<AttachmentStorage["removeManaged"]>[0]) {
          linkJiraKey(handle.db, subject.id, "ACME-9");
          return super.removeManaged(attachment);
        }
      }

      await pullItem(handle.db, context(jira), subject.id, new RelinkingOnRemove(storageRoot));

      // The first went, because at that moment the item really did
      // mirror ACME-8. The second is the ACME-9 item's, and ACME-8's
      // listing has no say over it.
      const after = listAttachmentsForItem(handle.db, subject.id);
      expect(after.map((entry) => entry.id)).toEqual([before[1]!.id]);
      expect(existsSync(before[1]!.path), "the surviving row's bytes are still there").toBe(true);
      expect(existsSync(before[0]!.path)).toBe(false);
    });

    it("keeps the old issue's file off the item, and its bytes off the disk, when the relink lands mid-write", async () => {
      // The last gap in a pull: the download has finished and passed the
      // guard, and `storeImported` is renaming the bytes into managed
      // storage. Resuming from that into `insertAttachments` would file
      // ACME-8's document on an item mirroring ACME-9, where nothing on
      // it says which issue it came from — and the bytes would sit in
      // managed storage with no row pointing at them.
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");
      let storedAt: string | null = null;
      class RelinkingStorage extends AttachmentStorage {
        override async storeImported(input: Parameters<AttachmentStorage["storeImported"]>[0]) {
          const stored = await super.storeImported(input);
          storedAt = stored.storagePath;
          // Inside the await, from EO's point of view: the write handler
          // ran while this promise was outstanding.
          linkJiraKey(handle.db, subject.id, "ACME-9");
          return stored;
        }
      }
      const storage = new RelinkingStorage(join(directory, "files"));

      const result = await pullPending(handle.db, context(withOneFile()), storage);

      expect(result.attachments).toBe(0);
      expect(listAttachmentsForItem(handle.db, subject.id)).toEqual([]);
      // Nor the owner note the file would have hung off, which carries
      // ACME-8's key in its `jiraCommentId` and would be a comment on an
      // ACME-9 item claiming to come from an issue it no longer
      // mirrors. (The field reconciliation above it stands: it ran while
      // the item really did mirror ACME-8.)
      expect(listCommentsForItem(handle.db, subject.id).some((entry) => entry.body === "Attachments synchronized from Jira.")).toBe(false);
      expect(storedAt).not.toBeNull();
      expect(existsSync(storedAt!), "the bytes went with the row that was never written").toBe(false);
      expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
    });

    it("keeps the old issue's files off the item that has moved on", async () => {
      // The longest gap in a pull is a download, so the attachment sync
      // asks the same question once per file.
      const storage = new AttachmentStorage(join(directory, "files"));
      const subject = unlinked("What EO was told");
      attach(subject.id, "ACME-8");

      await pullPending(
        handle.db,
        // Mid-download, which is where a person clicking Attach lands on
        // a big file.
        context(
          withOneFile(() => {
            linkJiraKey(handle.db, subject.id, "ACME-9");
          }),
        ),
        storage,
      );

      expect(listAttachmentsForItem(handle.db, subject.id)).toEqual([]);
      expect(isJiraPullPending(handle.db, subject.id)).toBe(true);
    });
  });

  /**
   * A plan whose feature is an epic that already exists (EO-124/EO-127).
   *
   * The case that had nothing to ask about it: `applyNewFeature` gives
   * every feature it creates no workspace at all, because a feature's
   * work is spread across whichever repositories its stories are on
   * (KAN-17), and until KAN-130 the Jira configuration was a
   * repository's — so a mirrored epic had no route to a site. The
   * binding is the project's now, and a feature always has one of
   * those, which is what makes this an ordinary pull rather than a
   * special case.
   */
  it("drains a plan's epic and its stories, end to end", async () => {
    const submitted = submitPlan(handle.db, undefined, {
      projectId,
      title: "Rate limit the importer",
      understanding: "Agreed outside EO, and already written up as an epic.",
      decisions: [],
      jiraKey: "ACME-7",
      stories: [
        { title: "The limiter", body: "Cap it.", acceptance_criteria: ["429 after the cap"], depends_on: [], touches: [], jira_key: "ACME-9" },
      ],
    });
    expect(submitted.created).toBe(true);

    const feature = getItemByKey(handle.db, submitted.featureKey!)!;
    const child = getItemByKey(handle.db, submitted.storyKeys[0]!)!;
    // The shape that made this fail: the epic is mirrored and sits in
    // no workspace, so nothing about where the *work* happens says
    // which Jira. Its project does.
    expect(feature.workspaceId).toBeNull();
    expect(feature.projectId).toBe(projectId);
    expect(isJiraPullPending(handle.db, feature.id)).toBe(true);

    const perIssue: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const key = /\/issue\/([^/?]+)/.exec(path)?.[1] ?? "";
      if (path.endsWith("/comment")) return json({ comments: [{ id: `c-${key}`, body: `A note on ${key}.`, author: { name: "Dana" } }], total: 1 });
      return json({ id: "1", key, fields: { summary: `${key}'s summary`, description: `${key}'s description`, updated: "x" } });
    };

    const result = await pullPending(handle.db, context(perIssue));

    expect(result.problem).toBeNull();
    // The epic's own text and thread, which is what nothing could reach
    // before: `pullItem` refused it for having no repository to read a
    // connection off, so its marker stayed set for ever.
    expect(getItem(handle.db, feature.id)?.title).toBe("ACME-7's summary");
    expect(listCommentsForItem(handle.db, feature.id).some((entry) => entry.jiraCommentId === "c-ACME-7")).toBe(true);
    expect(isJiraPullPending(handle.db, feature.id)).toBe(false);
    // And the story under it, from its own marker and again as the
    // epic's child — either way, once.
    expect(getItem(handle.db, child.id)?.title).toBe("ACME-9's summary");
    expect(listCommentsForItem(handle.db, child.id).filter((entry) => entry.jiraCommentId === "c-ACME-9")).toHaveLength(1);
    expect(isJiraPullPending(handle.db, child.id)).toBe(false);
  });

  it("asks each child's own Jira when a feature's stories sit on two projects", async () => {
    // This used to be two repositories on one project, each connected to
    // its own Jira site. One project has exactly one binding since
    // KAN-130, so that shape cannot happen any more — but the question it
    // was really asking survives whole, because a child may sit on
    // another project: a plan's stories get moved about. A feature is
    // answered for by its own project's binding, which need not be its
    // children's, so handing every child the feature's client fetches
    // OTHER-3 from the site that has never heard of it, and the epic's
    // marker then retries for ever even though every item has a
    // perfectly good connection.
    const web = attachWorkspace(handle.db, { name: "web", keyPrefix: "WEB", repoPath: "/tmp/web" });
    const otherProject = projectForWorkspace(handle.db, web.id)!;
    const otherSite = createJiraConnection(handle.db, { baseUrl: "https://jira.other.internal", flavour: "datacenter" });
    saveJiraBinding(handle.db, otherProject.id, { connectionId: otherSite.id, projectKey: "OTHER" });
    storeToken({ directory, store }, otherSite.id, "pat");

    // No workspace on the feature, which is what `applyNewFeature` makes
    // (KAN-17) and what a plan handed over whole leaves behind.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limit everything", stepId: null, projectId });
    const onApi = createTestItem(handle.db, {
      type: "story",
      title: "The limiter",
      stepId: "todo",
      parentId: feature.id,
      workspaceId: workspace.id,
      projectId,
    });
    const onWeb = createTestItem(handle.db, {
      type: "story",
      title: "The banner",
      stepId: "todo",
      parentId: feature.id,
      workspaceId: web.id,
      projectId: otherProject.id,
    });
    attach(feature.id, "ACME-7");
    attach(onApi.id, "ACME-9");
    attach(onWeb.id, "OTHER-3");

    // Each site knows only its own project, as two real Jiras would —
    // so asking the wrong one is a 404, which is what turned this into
    // an epic whose marker never cleared.
    const asked: string[] = [];
    const bothSites: FetchLike = async (url) => {
      const parsed = new URL(url);
      const key = /\/issue\/([^/?]+)/.exec(parsed.pathname)?.[1] ?? "";
      if (parsed.pathname.endsWith("/comment")) return json({ comments: [], total: 0 });
      asked.push(`${parsed.host} ${key}`);
      const theirs = parsed.host === "jira.acme.internal" ? "ACME" : "OTHER";
      if (!key.startsWith(theirs)) return json({ errorMessages: [`Issue does not exist or you do not have permission to see it.`] }, 404);
      return json({ id: "1", key, fields: { summary: `${key}'s summary`, description: "", updated: "x" } });
    };

    const result = await pullPending(handle.db, context(bothSites));

    expect(result.problem).toBeNull();
    // Each issue at its own endpoint. The epic and the ACME story are
    // on the ACME site; the OTHER story is on the other one.
    expect(asked).toContain("jira.acme.internal ACME-7");
    expect(asked).toContain("jira.acme.internal ACME-9");
    expect(asked).toContain("jira.other.internal OTHER-3");
    expect(asked, "and never at the wrong site").not.toContain("jira.acme.internal OTHER-3");

    expect(getItem(handle.db, feature.id)?.title).toBe("ACME-7's summary");
    expect(getItem(handle.db, onApi.id)?.title).toBe("ACME-9's summary");
    expect(getItem(handle.db, onWeb.id)?.title).toBe("OTHER-3's summary");
    // And the epic's marker clears, which it could not while one of its
    // children was being asked of a Jira that has never heard of it.
    expect(isJiraPullPending(handle.db, feature.id)).toBe(false);
    expect(isJiraPullPending(handle.db, onWeb.id)).toBe(false);
  });

  it("waits for a project bound to the epic's own Jira project", async () => {
    // The fallback for an item on no project at all, and its limit. It
    // is "whichever binding mirrors the Jira project this key names",
    // not "whichever binding comes first" — an installation with several
    // has several answers and all but one of them are wrong for ACME-7,
    // so an epic whose key matches none of them waits rather than being
    // asked about at the wrong site.
    saveJiraBinding(handle.db, projectId, { projectKey: "OTHER" });
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
    attach(feature.id, "ACME-7");
    let asked = 0;
    const counting: FetchLike = async (url, init) => {
      asked += 1;
      return jiraHolding({}).fetchImpl(url, init);
    };

    await pullPending(handle.db, context(counting));

    expect(asked).toBe(0);
    expect(isJiraPullPending(handle.db, feature.id)).toBe(true);
  });

  it("has nothing to drain for an item attached with sync off", async () => {
    // The switch, at the moment it matters most: attaching with sync off
    // sets no marker, so nothing is asked of Jira at all.
    const subject = unlinked("Count requests");
    setJiraSync(handle.db, subject.id, false);
    attach(subject.id, "ACME-8");
    let asked = 0;
    const counting: FetchLike = async (url, init) => {
      asked += 1;
      return jiraHolding({}).fetchImpl(url, init);
    };

    expect(isJiraPullPending(handle.db, subject.id)).toBe(false);
    await pullPending(handle.db, context(counting));
    expect(asked).toBe(0);
  });
});
