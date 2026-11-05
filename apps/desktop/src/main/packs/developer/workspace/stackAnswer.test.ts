import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Item } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { createAgent, postComment, type GitWorkspace } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { recordedStackAnswer } from "./stackAnswer.js";

/**
 * Reading a person's answer back out of the thread (KAN-42's tie case).
 *
 * Comments are the only communication channel (invariant #4), so the
 * thread is where the answer lives — and re-reading it has to be
 * predictable, because three different steps do it at three different
 * moments in an item's life.
 */

let handle: DbHandle;
let repository: GitWorkspace;
let item: Item;
let first: Item;
let second: Item;

/** No repository on disk: every ref the tests name is declared here instead. */
function repoWith(refs: string[]) {
  return async (_repoPath: string, ref: string) => refs.includes(ref);
}

function ask(): void {
  postComment(handle.db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body: "EO-1 and EO-2 are both still open.",
    options: ["EO-1", "EO-2"],
    mentions: [{ type: "human" }],
  });
}

function reply(body: string): void {
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, body });
}

async function answer() {
  return recordedStackAnswer({
    db: handle.db,
    item,
    choices: [first, second],
    repoPath: repository.config.repoPath,
    refExists: repoWith(["release/24.3"]),
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "the repo", keyPrefix: "EO", repoPath: "/does/not/matter", baseBranch: "main" });
  const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: "todo", workspaceId: repository.id });
  const common = { type: "story" as const, stepId: "todo", workspaceId: repository.id, parentId: feature.id };
  first = createTestItem(handle.db, { ...common, title: "First" });
  second = createTestItem(handle.db, { ...common, title: "Second" });
  item = createTestItem(handle.db, { ...common, title: "Dependent" });
});

afterEach(() => {
  handle.close();
});

describe("recordedStackAnswer", () => {
  it("finds nothing in a thread nobody has spoken in", async () => {
    expect(await answer()).toBeUndefined();
  });

  it("reads the dependency a person named in reply to the escalation", async () => {
    ask();
    reply(second.key);

    expect(await answer()).toEqual({ kind: "dependency", key: second.key });
  });

  it("reads a branch a person named, once the repository is confirmed to have it", async () => {
    ask();
    reply("release/24.3");

    expect(await answer()).toEqual({ kind: "branch", branch: "release/24.3" });
  });

  it("refuses a branch the repository does not have, and says which one", async () => {
    // Verify, don't trust (invariant #5): finding this out here beats
    // letting `git worktree add` fail with it mid-dispatch.
    ask();
    reply("release/nope");

    const result = await answer();
    expect(result?.kind).toBe("unusable");
    if (result?.kind !== "unusable") return;
    expect(result.problem).toContain("no branch or ref");
    expect(result.problem).toContain("release/nope");
  });

  /**
   * The other half of EO-184, at the reader that decides where a branch
   * is cut from.
   *
   * A person who answers "whichever one the limiter lives in" has
   * answered — just not in a key this can read. The system agent reads
   * it for them and files the key under their reply, and this is where
   * that has to land: the shared reader counts a system agent's comment
   * as an answer only when it is filed under a person's, so the answer
   * reaches `git worktree add` through exactly the same path a typed key
   * does.
   */
  it("reads the key the system agent filed under a reply nobody could match", async () => {
    const agent = createAgent(handle.db, { name: "EO", role: "system", provider: "claude", instructions: "" });
    ask();
    const said = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "whichever one the limiter lives in" });
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agent.id },
      parentId: said.id,
      kind: "decision",
      body: second.key,
    });

    expect(await answer()).toEqual({ kind: "dependency", key: second.key });
  });

  it("lets a person change their mind — the newest usable answer wins", async () => {
    ask();
    reply(first.key);
    reply(second.key);

    expect(await answer()).toEqual({ kind: "dependency", key: second.key });
  });

  it("keeps an answer that is still readable when a later reply is about something else", async () => {
    // The failure this prevents: EO asks, gets an answer, acts on it, and
    // then a *different* guard trips. Whatever a person says to that must
    // not erase the decision they already made.
    ask();
    reply(second.key);
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      body: "The repository has uncommitted changes.",
      mentions: [{ type: "human" }],
    });
    reply("committed them, go ahead");

    expect(await answer()).toEqual({ kind: "dependency", key: second.key });
  });

  it("reports a reply it could not read, so the next escalation can quote it", async () => {
    ask();
    reply("do whichever you prefer");

    const result = await answer();
    expect(result?.kind).toBe("unusable");
    if (result?.kind !== "unusable") return;
    expect(result.answer).toBe("do whichever you prefer");
  });

  it("does not quote an unreadable comment written before EO asked anything", async () => {
    // Nobody was answering: there was no question yet. Quoting it back as
    // a failed answer would be EO putting words in somebody's mouth.
    reply("do whichever you prefer");

    expect(await answer()).toBeUndefined();
  });

  it("ignores a comment that arrived from Jira", async () => {
    // Same rule that stops a pulled comment closing a mention: nobody
    // answered EO — a sync found somebody talking in Jira.
    ask();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: second.key, jiraCommentId: "10001" });

    expect(await answer()).toBeUndefined();
  });

  it("ignores what an agent said, however much it looks like an answer", async () => {
    ask();
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: second.key });

    expect(await answer()).toBeUndefined();
  });
});
