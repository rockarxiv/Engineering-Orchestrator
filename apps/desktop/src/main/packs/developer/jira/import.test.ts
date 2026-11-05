import { mkdtempSync, rmSync } from "node:fs";
import { jiraStateOf } from "@eo/core";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getItem, listAttachmentsForItem, listCommentsForItem, listItems, projectForWorkspace, saveJiraBinding, setJiraSync, type Workspace } from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { pipelines } from "../../../db/schema.js";
import { attachWorkspace, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { FetchLike } from "./client.js";
import type { JiraContext } from "./connection.js";
import type { SecretStore } from "../../../secrets/store.js";
import { storeToken } from "./credentials.js";
import { looksLikeKey, toJql } from "./import.js";
import { importJiraIssue, previewJiraIssue, searchJira } from "../../../ipc/jiraImportCommands.js";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../../../attachments/storage.js";

/**
 * Starting from an issue that already exists (J-02).
 *
 * Driven through the IPC commands rather than the import function
 * directly, because the interesting part is the whole path: a stored
 * credential, a client, a Jira that answers, and an item at the end.
 */
let handle: DbHandle;
let directory: string;
/** The `git-worktree` workspace every `repositoryId` in these payloads names. */
let workspace: Workspace;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  issueType?: string;
  status?: string;
  parentKey?: string | null;
}

function raw(issue: FakeIssue) {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description ?? "",
      issuetype: { name: issue.issueType ?? "Epic" },
      status: { name: issue.status ?? "To Do" },
      parent: issue.parentKey ? { key: issue.parentKey } : undefined,
    },
  };
}

/** A Data Center Jira, so descriptions are plain strings and the payloads stay readable. */
function jiraWith(issues: FakeIssue[], children: Record<string, FakeIssue[]> = {}): { fetchImpl: FetchLike; jql: string[] } {
  const jql: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    let body: unknown = {};

    if (url.includes("/search")) {
      const query = new URL(url).searchParams.get("jql") ?? "";
      jql.push(query);
      const parent = Object.keys(children).find((key) => query.includes(key));
      body = { issues: (parent ? children[parent]! : issues).map(raw) };
    } else if (url.includes("/issue/")) {
      const key = url.split("/issue/")[1]!.split("?")[0]!;
      const found = issues.concat(Object.values(children).flat()).find((issue) => issue.key === key);
      if (!found) return new Response(JSON.stringify({ errorMessages: [`Issue does not exist: ${key}`] }), { status: 404 });
      body = raw(found);
    }

    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, jql };
}

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

const EPIC: FakeIssue = { id: "10001", key: "ACME-7", summary: "Rate limiting", description: "Throttle the public API." };
const CHILDREN: FakeIssue[] = [
  { id: "10002", key: "ACME-8", summary: "Count requests per key", issueType: "Story", parentKey: "ACME-7" },
  { id: "10003", key: "ACME-9", summary: "Return 429 with Retry-After", issueType: "Story", parentKey: "ACME-7" },
];

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo jira import "));
  workspace = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: "/tmp/acme", baseBranch: "main" });
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  // On the project the workspace came with (KAN-130). Every `jira:*`
  // payload below still names a repository, because that is what the
  // picker is looking at; the connection it resolves to is its
  // project's.
  saveJiraBinding(handle.db, projectForWorkspace(handle.db, workspace.id)!.id, {
    connectionId: site.id,
    projectKey: "ACME",
    featureIssueType: "Epic",
    storyIssueType: "Story",
  });
  storeToken({ directory, store }, site.id, "pat");
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the JQL a search box turns into", () => {
  it("scopes every search to the configured Jira project", () => {
    // A picker that can reach every issue in the instance is a
    // different and much less useful thing.
    expect(toJql("ACME", "rate limit")).toContain('project = "ACME"');
    expect(toJql("ACME", 'status = "In Progress"')).toContain('project = "ACME"');
    expect(toJql("ACME", "")).toBe('project = "ACME" ORDER BY updated DESC');
  });

  it("takes JQL when it looks like JQL and words when it looks like words", () => {
    expect(toJql("ACME", 'assignee = currentUser()')).toContain("AND (assignee = currentUser())");
    expect(toJql("ACME", "rate limit")).toContain('summary ~ "rate limit"');
  });

  it("does not let a quote end the string early", () => {
    // Otherwise a summary containing a quote is a syntax error at best.
    expect(toJql("ACME", 'say "hi')).not.toContain('"hi"');
    expect(toJql("ACME", 'say "hi')).toContain('summary ~ "say  hi"');
  });

  it("knows a key from a phrase", () => {
    expect(looksLikeKey("ACME-12")).toBe(true);
    expect(looksLikeKey("acme-12")).toBe(true);
    expect(looksLikeKey("rate limiting")).toBe(false);
    expect(looksLikeKey("ACME")).toBe(false);
  });
});

describe("searching", () => {
  it("finds issues in the configured Jira project", async () => {
    const jira = jiraWith([EPIC]);

    const result = await searchJira(handle.db, context(jira.fetchImpl), { repositoryId: workspace.id, query: "rate" });

    expect(result.problem).toBeNull();
    expect(result.issues).toEqual([
      { id: "10001", key: "ACME-7", summary: "Rate limiting", description: "Throttle the public API.", issueType: "Epic", status: "To Do", parentKey: null, updated: "" },
    ]);
  });

  it("looks a full key up directly, because text search does not match on it", async () => {
    const jira = jiraWith([EPIC]);

    const result = await searchJira(handle.db, context(jira.fetchImpl), { repositoryId: workspace.id, query: "acme-7" });

    expect(result.issues.map((issue) => issue.key)).toEqual(["ACME-7"]);
    expect(jira.jql).toEqual([]); // a lookup, not a search
  });

  it("says a repository isn't connected rather than returning nothing", async () => {
    const other = attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/other", baseBranch: "main" });

    const result = await searchJira(handle.db, context(jiraWith([]).fetchImpl), { repositoryId: other.id, query: "rate" });

    expect(result.issues).toEqual([]);
    expect(result.problem).toContain("not connected");
  });

  it("surfaces Jira's own words when the query is rejected", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ errorMessages: ["Field 'nonsense' does not exist or you do not have permission to view it."] }), { status: 400 });

    const result = await searchJira(handle.db, context(fetchImpl), { repositoryId: workspace.id, query: "nonsense = 1" });

    expect(result.problem).toContain("does not exist or you do not have permission");
  });
});

describe("importing an issue", () => {
  it("becomes a feature that carries its key", async () => {
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "plan",
    });

    const feature = getItem(handle.db, result.itemId as never)!;
    expect(feature).toMatchObject({ type: "feature", title: "Rate limiting", stepId: null });
    expect(jiraStateOf(feature)).toMatchObject({ key: "ACME-7", id: "10001" });
    expect(feature.key).toMatch(/^ACME-\d+$/); // EO's own key, not Jira's
  });

  it("backfills every eligible Jira attachment without applying EO's eight-file submission cap", async () => {
    const base = jiraWith([EPIC]);
    const metadata = [
      ...Array.from({ length: 9 }, (_, index) => ({ id: String(500 + index), filename: `file-${index}.txt`, mimeType: "text/plain", size: 4, content: `https://jira.acme.internal/content/${500 + index}` })),
      { id: "huge", filename: "huge.bin", mimeType: "application/octet-stream", size: MAX_ATTACHMENT_BYTES + 1, content: "https://jira.acme.internal/content/huge" },
    ];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("fields=attachment")) return new Response(JSON.stringify({ fields: { attachment: metadata } }), { status: 200 });
      if (url.includes("/content/")) return new Response(new TextEncoder().encode("data"), { status: 200 });
      return base.fetchImpl(url, init);
    };
    const attachmentStorage = new AttachmentStorage(join(directory, "attachments"));

    const result = await importJiraIssue(handle.db, context(fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "plan",
    }, attachmentStorage);

    expect(result.problem).toBeNull();
    expect(listAttachmentsForItem(handle.db, result.itemId as never)).toHaveLength(9);
  });

  it("does not backfill files into an item whose Jira sync was switched off since it was imported", async () => {
    // Re-picking an issue EO already has opens what exists rather than
    // making a second copy — and if that item has since been silenced,
    // this loop is a way in for the inbound half of the switch (EO-122).
    // A fresh import can never hit this: `createItem` defaults sync on.
    const metadata = [{ id: "500", filename: "file.txt", mimeType: "text/plain", size: 4, content: "https://jira.acme.internal/content/500" }];
    const base = jiraWith([EPIC]);
    const downloads: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes("fields=attachment")) return new Response(JSON.stringify({ fields: { attachment: metadata } }), { status: 200 });
      if (url.includes("/content/")) {
        downloads.push(url);
        return new Response(new TextEncoder().encode("data"), { status: 200 });
      }
      return base.fetchImpl(url, init);
    };
    const attachmentStorage = new AttachmentStorage(join(directory, "attachments"));
    const input = { repositoryId: workspace.id, key: "ACME-7", mode: "plan" as const };

    const first = await importJiraIssue(handle.db, context(fetchImpl), undefined, input, attachmentStorage);
    expect(listAttachmentsForItem(handle.db, first.itemId as never)).toHaveLength(1);
    downloads.length = 0;
    setJiraSync(handle.db, first.itemId as never, false);

    const second = await importJiraIssue(handle.db, context(fetchImpl), undefined, input, attachmentStorage);

    expect(second.alreadyImported).toBe(true);
    // Nothing downloaded, and nothing new attached.
    expect(downloads).toEqual([]);
    expect(listAttachmentsForItem(handle.db, first.itemId as never)).toHaveLength(1);
    // Reported, because this is the one thing asked for that did not happen.
    expect(second.problem).toContain("switched off");
  });

  it("puts the description in the thread, where a described feature puts it", async () => {
    // U-08: intake *is* a comment thread. A description sitting in a
    // field beside it would be read twice and answered nowhere.
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "plan",
    });

    const comments = listCommentsForItem(handle.db, result.itemId as never);
    expect(comments[0]).toMatchObject({ authorType: "human", body: "Throttle the public API." });
    expect(comments[1]?.body).toContain("Imported from ACME-7");
  });

  it("imports children as stories ready to work, with their own keys", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "children",
    });

    expect(result.storyCount).toBe(2);
    const stories = listItems(handle.db, workspace.id).filter((item) => item.type === "story");
    expect(stories.map((story) => jiraStateOf(story).key).sort()).toEqual(["ACME-8", "ACME-9"]);
    expect(stories.every((story) => story.parentId === result.itemId)).toBe(true);
    expect(stories.every((story) => story.stepId === "worktree")).toBe(true);
  });

  it("is refused whole by the pipeline's entry rules, in the words importing refuses in (EO-610)", async () => {
    handle.db.update(pipelines).set({ entryRules: [{ kind: "description" }] }).where(eq(pipelines.id, "default")).run();
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "children" });

    expect(result).toMatchObject({ itemId: null, storyCount: 0, problem: '"Delivery" needs these before work can enter it: a description.' });
    expect(listItems(handle.db, workspace.id)).toEqual([]);
  });

  it("files a Jira key an entry rule asks for (EO-610)", async () => {
    handle.db.update(pipelines).set({ entryRules: [{ kind: "jira_key" }] }).where(eq(pipelines.id, "default")).run();
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "children" });

    expect(result.storyCount).toBe(2);
  });

  /**
   * EO-302: an imported issue says nobody created it here.
   *
   * Somebody filed ACME-7 in Jira, and EO has no person row for them.
   * Naming whoever pressed Import would be recording a fact that is not
   * true, and it is the one case where the "created by the one person
   * there is" default in `createItem` would be wrong — which is why
   * this path says `null` out loud rather than leaving the default to
   * decide.
   */
  it("leaves an imported issue and its children saying nobody here created them", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "children",
    });

    expect(getItem(handle.db, result.itemId as never)!.createdBy).toBeNull();
    const stories = listItems(handle.db, workspace.id).filter((item) => item.type === "story");
    expect(stories.every((story) => story.createdBy === null)).toBe(true);
  });

  it("gives an imported container no pipeline, like any other feature", async () => {
    // Refining an epic whose stories were just imported would produce a
    // second, competing plan for the same work.
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "children",
    });

    expect(getItem(handle.db, result.itemId as never)?.stepId).toBeNull();
  });

  it("leaves the children in Jira alone when EO is asked to plan it instead", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "plan",
    });

    expect(result.storyCount).toBe(0);
    expect(listItems(handle.db, workspace.id).filter((item) => item.type === "story")).toEqual([]);
    expect(getItem(handle.db, result.itemId as never)?.stepId).toBeNull();
    // And it says what became of them, rather than leaving someone to
    // wonder whether EO saw them at all (invariant #8).
    expect(listCommentsForItem(handle.db, result.itemId as never).at(-1)?.body).toContain("left in Jira");
  });

  it("takes an issue as written: one story, no feature, entering the pipeline", async () => {
    // KAN-19. No feature above it, because there is nothing to
    // decompose — and `backlog` rather than `todo` because a person
    // still reads it before anyone builds it.
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
    });

    const item = getItem(handle.db, result.itemId as never)!;
    expect(item).toMatchObject({ type: "story", stepId: "worktree", parentId: null });
    expect(jiraStateOf(item).key).toBe("ACME-7");
    expect(result.storyCount).toBe(0);
    expect(listItems(handle.db, workspace.id).filter((candidate) => candidate.type === "feature")).toEqual([]);
  });

  it("puts written work in the body, where the implementer reads it", async () => {
    // The opposite of a feature, whose description opens a conversation
    // (U-08). This one is the specification, and duplicating it into the
    // thread would put the same words in the agent's context twice.
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
    });

    expect(getItem(handle.db, result.itemId as never)?.body).toBe("Throttle the public API.");
    const comments = listCommentsForItem(handle.db, result.itemId as never);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "engine" });
    expect(comments[0]?.body).toContain("as written");
  });

  it("imports a bug or a task as written, not only something called a story", async () => {
    // The Jira issue type is a team's own vocabulary and says nothing
    // about whether the words in it are finished work.
    const jira = jiraWith([{ ...EPIC, issueType: "Bug" }]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
    });

    expect(getItem(handle.db, result.itemId as never)).toMatchObject({ type: "story", stepId: "worktree" });
  });

  it("leaves the Jira children alone when the parent is taken as written", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
    });

    expect(result.storyCount).toBe(0);
    expect(listItems(handle.db, workspace.id)).toHaveLength(1);
    expect(listCommentsForItem(handle.db, result.itemId as never).at(-1)?.body).toContain("left in Jira");
  });

  it("puts the work in the repository asked for, not the one holding the Jira connection", async () => {
    // KAN-19. On a project spanning two repositories these are different
    // questions, and getting it wrong sends the worktree, the branch and
    // the pull request to the wrong repo — silently.
    const other = attachWorkspace(handle.db, { name: "acme-web", keyPrefix: "WEB", repoPath: "/tmp/web" });
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
      targetProjectId: other.id,
    });

    expect(getItem(handle.db, result.itemId as never)?.workspaceId).toBe(other.id);
  });

  it("says so when the chosen repository's project has no Jira of its own", async () => {
    // The item keeps its key and its link, but nothing will travel
    // back. Better said now than noticed when Jira stops moving. The
    // chosen repository is on a project of its own here, and that project
    // is what holds — or in this case lacks — a binding.
    const other = attachWorkspace(handle.db, { name: "acme-web", keyPrefix: "WEB", repoPath: "/tmp/web" });
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
      targetProjectId: other.id,
    });

    expect(listCommentsForItem(handle.db, result.itemId as never).at(-1)?.body).toContain("will not mirror the status back");
  });

  it("says nothing of the sort when the repository is the connected one", async () => {
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "asWritten" });

    expect(listCommentsForItem(handle.db, result.itemId as never).map((comment) => comment.body).join("\n")).not.toContain("not connected to Jira");
  });

  it("still finds the first import when the second aims at another repository", async () => {
    // The duplicate check used to be scoped to the connected repository,
    // which stops being the item's repository the moment there is a
    // choice — so the same issue would come in twice.
    const other = attachWorkspace(handle.db, { name: "acme-web", keyPrefix: "WEB", repoPath: "/tmp/web" });
    const jira = jiraWith([EPIC]);
    const first = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "asWritten" });

    const second = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "asWritten",
      targetProjectId: other.id,
    });

    expect(second.alreadyImported).toBe(true);
    expect(second.itemId).toBe(first.itemId);
  });

  it("opens what exists instead of importing the same issue twice", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });
    const first = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "children" });

    const second = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "children" });

    expect(second.alreadyImported).toBe(true);
    expect(second.itemId).toBe(first.itemId);
    expect(listItems(handle.db, workspace.id).filter((item) => item.type === "feature")).toHaveLength(1);
    expect(listItems(handle.db, workspace.id).filter((item) => item.type === "story")).toHaveLength(2);
  });

  it("reports a missing issue rather than creating an empty feature", async () => {
    const jira = jiraWith([EPIC]);

    const result = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-404",
      mode: "plan",
    });

    expect(result.itemId).toBeNull();
    expect(result.problem).toContain("Issue does not exist");
    expect(listItems(handle.db, workspace.id)).toEqual([]);
  });

  it("re-reads the issue at import rather than trusting what the picker showed", async () => {
    // The dialog may have been open a while. What gets imported is what
    // Jira says now.
    const jira = jiraWith([EPIC]);
    await previewJiraIssue(handle.db, context(jira.fetchImpl), { repositoryId: workspace.id, key: "ACME-7" });

    const renamed = jiraWith([{ ...EPIC, summary: "Rate limiting, revised" }]);
    const result = await importJiraIssue(handle.db, context(renamed.fetchImpl), undefined, {
      repositoryId: workspace.id,
      key: "ACME-7",
      mode: "plan",
    });

    expect(getItem(handle.db, result.itemId as never)?.title).toBe("Rate limiting, revised");
  });
});

describe("previewing an issue", () => {
  it("says what EO already has, so the picker can offer to open it", async () => {
    const jira = jiraWith([EPIC], { "ACME-7": CHILDREN });
    const imported = await importJiraIssue(handle.db, context(jira.fetchImpl), undefined, { repositoryId: workspace.id, key: "ACME-7", mode: "plan" });

    const preview = await previewJiraIssue(handle.db, context(jira.fetchImpl), { repositoryId: workspace.id, key: "ACME-7" });

    expect(preview.existingItemId).toBe(imported.itemId);
    expect(preview.children.map((child) => child.key)).toEqual(["ACME-8", "ACME-9"]);
  });

  it("finds nothing existing for an issue nobody has imported", async () => {
    const jira = jiraWith([EPIC]);

    const preview = await previewJiraIssue(handle.db, context(jira.fetchImpl), { repositoryId: workspace.id, key: "ACME-7" });

    expect(preview.existingItemId).toBeNull();
    expect(preview.issue).toMatchObject({ key: "ACME-7" });
  });
});
