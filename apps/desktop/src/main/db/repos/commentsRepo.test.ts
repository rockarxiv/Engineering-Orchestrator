import { LOCAL_PERSON_ID, type Agent, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { comments } from "../schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { archiveAgent, createAgent, listAgents } from "./agentsRepo.js";
import {
  deleteComment,
  getComment,
  knownJiraCommentIds,
  listCommentsForItem,
  listMentionsForComment,
  needsAttention,
  openMentionsForHuman,
  postComment,
  resolveMentions,
  setJiraCommentId,
} from "./commentsRepo.js";
import { pendingPushesForItem } from "./outboxRepo.js";
import { setJiraSync, updateItem } from "./itemsRepo.js";

describe("commentsRepo", () => {
  let handle: DbHandle;
  let item: Item;
  let allAgents: Agent[];

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    allAgents = listAgents(handle.db);
  });

  afterEach(() => {
    handle.close();
  });

  function agentByRole(role: string): Agent {
    return allAgents.find((agent) => agent.role === role)!;
  }

  it("posting a comment with @user creates a comment row and an open human mention atomically", () => {
    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "Hey @user, can you confirm this?",
    });

    expect(getComment(handle.db, comment.id)).toEqual(comment);
    expect(listMentionsForComment(handle.db, comment.id)).toEqual([
      { commentId: comment.id, targetType: "human", targetId: LOCAL_PERSON_ID, status: "open", addressedBy: null },
    ]);
  });

  it("resolves @role mentions in the body and merges them with the explicit mentions array", () => {
    const implementer = agentByRole("implementer");
    const reviewer = agentByRole("reviewer");

    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "cc @implementer",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });

    const targetIds = listMentionsForComment(handle.db, comment.id)
      .map((mention) => mention.targetId)
      .sort();
    expect(targetIds).toEqual([implementer.id, reviewer.id].sort());
  });

  it("does not let a token with no letters in it mention an agent whose name has none either", () => {
    // `normalizeMentionToken` strips everything but [a-z0-9], so "@---"
    // and an agent called "•••" both come out as the empty string and
    // compare equal. Nothing stops either: agent names are free text
    // (`z.string()`, no pattern), and a body legitimately contains
    // punctuation runs — a horizontal rule, an em-dash, "@--".
    //
    // The result is a dispatch nobody asked for, off a comment that does
    // not mention anyone.
    createAgent(handle.db, { name: "•••", role: "•••", provider: "fake", instructions: "x" });

    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "splitting this out @--- see above",
    });

    expect(listMentionsForComment(handle.db, comment.id)).toEqual([]);
  });

  it("leaves an unresolved @token as plain text rather than erroring", () => {
    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "not a real agent: @whoisthis",
    });

    expect(listMentionsForComment(handle.db, comment.id)).toEqual([]);
  });

  it("leaves a token naming an archived agent as plain text too", () => {
    // An archived agent is dispatched to nothing (EO-186), so a mention
    // of one is a request nothing will ever answer. This path writes the
    // rows for comments arriving from Jira and from modules as well as
    // for what somebody types, and there is nobody to refuse to on those
    // — so a token that names a retired agent is treated as the
    // unresolvable name it now is. `resolveAndValidateMentions` is where
    // it *is* refused out loud, because there somebody is listening.
    const retired = createAgent(handle.db, { name: "Retired Tester", role: "tester", provider: "fake", instructions: "x" });
    archiveAgent(handle.db, retired.id);

    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@tester could have looked at this",
    });

    expect(listMentionsForComment(handle.db, comment.id)).toEqual([]);
  });

  it("openMentionsForHuman() returns newest-first and excludes addressed mentions", () => {
    const first = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user first question",
    });
    const second = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("reviewer").id },
      body: "@user second question",
    });

    const open = openMentionsForHuman(handle.db);
    expect(open.map((entry) => entry.comment.id)).toEqual([second.id, first.id]);

    // A human reply resolves both outstanding human mentions on this item.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "got it, on both" });
    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("needsAttention() flips to false when the open human mention is addressed, with no separate write", () => {
    expect(needsAttention(handle.db, item.id)).toBe(false);

    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user need a decision here",
    });
    expect(needsAttention(handle.db, item.id)).toBe(true);

    // No call to any "mark resolved" function beyond posting the reply —
    // needsAttention is a pure derived query, not a stored flag.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "decision: go ahead" });
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  /**
   * A module's note is not an answer (EO-75).
   *
   * `!` derives from an open human mention (invariant #6), and a remark
   * at the bottom of a thread clears every open one on the item —
   * which is the deliberate convenience it always was, for a *person*
   * typing an answer. A module leaving a note while a run waits on a
   * human would otherwise take the `!` off a question nobody answered.
   */
  it("does not let a module's comment close a question waiting on a human", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user which environment?",
    });
    expect(needsAttention(handle.db, item.id)).toBe(true);

    postComment(handle.db, { itemId: item.id, author: { type: "module" }, body: "**Deploy** (module)\n\nStaging is up.", parseBodyMentions: false });

    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  /**
   * And it does mirror, unlike an engine note (EO-75).
   *
   * The engine skip exists because an engine note is EO talking about
   * its own bookkeeping. A module's note is something that ran and had
   * something to say — and mirroring is the whole reason a comment
   * cannot be inserted straight into the table from the module host.
   */
  it("queues a module's comment for Jira, where an engine note stays put", () => {
    const workspace = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: workspace.id });
    updateItem(handle.db, mirrored.id, { jiraKey: "ACME-11" });

    postComment(handle.db, { itemId: mirrored.id, author: { type: "engine" }, body: "created ACME-11 in Jira" });
    expect(pendingPushesForItem(handle.db, mirrored.id, "jira")).toHaveLength(0);

    postComment(handle.db, { itemId: mirrored.id, author: { type: "module" }, body: "**Deploy** (module)\n\nStaging is up." });

    const queued = pendingPushesForItem(handle.db, mirrored.id, "jira");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload["authorType"]).toBe("module");
  });

  /**
   * And it stops mirroring when the switch is off (EO-122).
   *
   * The key is left in place deliberately: this is the state the switch
   * exists to make possible — an item that still knows which issue it
   * belongs to and says nothing to it.
   */
  it("queues no comment push once the item's Jira sync is switched off", () => {
    const workspace = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: workspace.id });
    updateItem(handle.db, mirrored.id, { jiraKey: "ACME-12" });

    postComment(handle.db, { itemId: mirrored.id, author: { type: "human" }, body: "Cap it at 100." });
    expect(pendingPushesForItem(handle.db, mirrored.id, "jira")).toHaveLength(1);

    setJiraSync(handle.db, mirrored.id, false);
    const local = postComment(handle.db, { itemId: mirrored.id, author: { type: "human" }, body: "Actually, 200." });

    expect(pendingPushesForItem(handle.db, mirrored.id, "jira")).toHaveLength(1);
    // The comment itself is unaffected — invariant 4 makes this the only
    // communication channel, and the switch is about Jira, not about EO.
    expect(listCommentsForItem(handle.db, mirrored.id).map((entry) => entry.id)).toContain(local.id);
  });

  it("replying to a mention marks it addressed and records addressed_by", () => {
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user blocked, need input",
    });

    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "here you go" });

    const [mention] = listMentionsForComment(handle.db, escalation.id);
    expect(mention).toMatchObject({ status: "addressed", addressedBy: reply.id });
  });

  it("resolveMentions() works as a standalone call, not only via postComment", () => {
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user please review",
    });

    // Insert the "reply" without going through postComment's own auto-resolve,
    // then resolve explicitly.
    const [mentionBefore] = listMentionsForComment(handle.db, escalation.id);
    expect(mentionBefore?.status).toBe("open");

    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "reviewed" });
    // postComment already resolved it; call resolveMentions again to prove
    // it's idempotent and safe to invoke directly too.
    resolveMentions(handle.db, reply.id);

    const [mentionAfter] = listMentionsForComment(handle.db, escalation.id);
    expect(mentionAfter).toMatchObject({ status: "addressed", addressedBy: reply.id });
  });

  it("closes the escalation when the reply actually answers it", () => {
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: "The budget guard stopped this run.",
    });

    const reply = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "raise it to $20 and carry on",
      parentId: escalation.id,
    });

    expect(listMentionsForComment(handle.db, escalation.id)[0]).toMatchObject({ status: "addressed", addressedBy: reply.id });
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("answering one question does not close an escalation the reply never touched", () => {
    // What threading (D-05) is for, and the reported bug in miniature:
    // replying to the question left the escalation resolved and its `!`
    // gone, with nobody having answered it.
    const implementer = agentByRole("implementer");
    const question = postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "@user which database?" });
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "escalation",
      mentions: [{ type: "human" }],
      body: "The budget guard stopped this run.",
    });

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Postgres", parentId: question.id });

    expect(listMentionsForComment(handle.db, question.id)[0]?.status).toBe("addressed");
    expect(listMentionsForComment(handle.db, escalation.id)[0]?.status).toBe("open");
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("a comment pulled from Jira answers nothing on its own", () => {
    // It arrives on a timer, and EO has no idea whether it addresses the
    // question — clearing the one marker that says a human is needed,
    // because somebody said something in Jira, loses the signal.
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user blocked, need input",
    });

    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "**Dana** in Jira:\n\nnice, shipping this week?",
      jiraCommentId: "10101",
    });

    expect(listMentionsForComment(handle.db, escalation.id)[0]?.status).toBe("open");
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("still lets an answer at the end of the thread clear what is open", () => {
    // Deliberately kept: a plain answer typed at the bottom is how an
    // escalation gets resolved and its run resumed, and a marker that
    // outlived a real answer would be worse than one that goes early.
    const question = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      kind: "escalation",
      body: "@user which limit should I use?",
    });

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "100 a minute" });

    expect(listMentionsForComment(handle.db, question.id)[0]?.status).toBe("addressed");
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("agents cannot resolve a target_type='human' mention — another agent's reply leaves it open", () => {
    const escalation = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("implementer").id },
      body: "@user need a call on this",
    });

    // A different agent posts on the same item — must NOT resolve the
    // human-targeted mention, only the escalating agent's own reply or a
    // human reply can.
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agentByRole("reviewer").id },
      body: "unrelated note",
    });

    const [mention] = listMentionsForComment(handle.db, escalation.id);
    expect(mention?.status).toBe("open");
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("an agent's reply resolves mentions targeting that same agent, not human mentions", () => {
    const implementer = agentByRole("implementer");
    const toAgent = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "please look at this",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, body: "on it" });

    const [mention] = listMentionsForComment(handle.db, toAgent.id);
    expect(mention?.status).toBe("addressed");
  });

  describe("deleting a comment", () => {
    it("takes the replies filed under it, and nothing else", () => {
      const question = postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: agentByRole("implementer").id }, body: "which database?" });
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Postgres", parentId: question.id });
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "unrelated, keep me", parentId: null });

      const { deletedIds } = deleteComment(handle.db, question.id);

      expect(deletedIds).toHaveLength(2);
      expect(listCommentsForItem(handle.db, item.id).map((entry) => entry.body)).toEqual(["unrelated, keep me"]);
    });

    it("re-opens a question whose only answer has just been deleted", () => {
      // `!` derives from open mentions (invariant #6). The answer no
      // longer exists, so the question is unanswered again — leaving it
      // "addressed" would point at a row that is gone.
      const question = postComment(handle.db, {
        itemId: item.id,
        author: { type: "agent", agentId: agentByRole("implementer").id },
        body: "@user which database?",
      });
      const answer = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Postgres", parentId: question.id });
      expect(needsAttention(handle.db, item.id)).toBe(false);

      deleteComment(handle.db, answer.id);

      expect(listMentionsForComment(handle.db, question.id)[0]).toMatchObject({ status: "open", addressedBy: null });
      expect(needsAttention(handle.db, item.id)).toBe(true);
    });

    it("drops a Jira push still queued for it", () => {
      // It would otherwise create, in Jira, a comment that no longer
      // exists here — and the next pull would import that back.
      const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
      const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: workspace.id });
      updateItem(handle.db, mirrored.id, { jiraKey: "ACME-8" });

      const comment = postComment(handle.db, { itemId: mirrored.id, author: { type: "human" }, body: "on its way to Jira" });
      expect(pendingPushesForItem(handle.db, mirrored.id)).toHaveLength(1);

      deleteComment(handle.db, comment.id);

      expect(pendingPushesForItem(handle.db, mirrored.id)).toHaveLength(0);
    });

    it("leaves another comment's queued push alone", () => {
      const workspace = attachWorkspace(handle.db, { name: "web", keyPrefix: "WEB", repoPath: "/tmp/web" });
      const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: workspace.id });
      updateItem(handle.db, mirrored.id, { jiraKey: "ACME-9" });

      const doomed = postComment(handle.db, { itemId: mirrored.id, author: { type: "human" }, body: "delete me" });
      postComment(handle.db, { itemId: mirrored.id, author: { type: "human" }, body: "keep me" });

      deleteComment(handle.db, doomed.id);

      expect(pendingPushesForItem(handle.db, mirrored.id)).toHaveLength(1);
    });

    it("reports which comments went, so the caller can clear them in Jira too", () => {
      const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "q" });
      const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "a", parentId: question.id });

      expect(new Set(deleteComment(handle.db, question.id).deletedIds)).toEqual(new Set([question.id, reply.id]));
    });
  });

  it("comments are ordered stably by created_at, then id", () => {
    // Bypass postComment to force two rows with an identical created_at,
    // proving the id tiebreak (postComment's own Date.now() calls are too
    // fast apart to reliably collide in a normal test run).
    const now = Date.now();
    const rowB = handle.db
      .insert(comments)
      .values({ id: "b-comment", itemId: item.id, authorType: "human", body: "b", createdAt: now })
      .returning()
      .get();
    const rowA = handle.db
      .insert(comments)
      .values({ id: "a-comment", itemId: item.id, authorType: "human", body: "a", createdAt: now })
      .returning()
      .get();

    const ordered = listCommentsForItem(handle.db, item.id);
    expect(ordered.map((c) => c.id)).toEqual([rowA.id, rowB.id]);
  });
});

/**
 * The guard that keeps EO from telling Jira what Jira just told it.
 *
 * Every non-engine comment on a mirrored item is queued for Jira. A
 * comment that arrived *from* Jira must not be, or the pull and the push
 * feed each other — and the sender appends "— via EO" on each pass, so
 * the body grows a suffix per cycle rather than settling.
 */
describe("comments that came from Jira", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: workspace.id });
    updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
  });

  afterEach(() => {
    handle.close();
  });

  it("are never queued back to Jira", () => {
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "Someone wrote this in Jira.",
      jiraCommentId: "10501",
    });

    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });

  it("while a locally written one still is", () => {
    // The negative half: the guard must not have turned the mirror off.
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "And this one is ours." });

    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(1);
  });

  it("remember which Jira comment they are", () => {
    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "From Jira.",
      jiraCommentId: "10501",
    });

    expect(comment.jiraCommentId).toBe("10501");
    expect(knownJiraCommentIds(handle.db, ["10501", "10502"])).toEqual(new Set(["10501"]));
  });

  it("are recognised once a pushed one has been acknowledged", () => {
    // The other direction: EO wrote it, pushed it, and Jira gave it an
    // id. A pull must recognise that id as already here.
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Ours." });
    setJiraCommentId(handle.db, comment.id, "10777");

    expect(knownJiraCommentIds(handle.db, ["10777"])).toEqual(new Set(["10777"]));
  });

  it("asks nothing of the database when there is nothing to ask about", () => {
    expect(knownJiraCommentIds(handle.db, [])).toEqual(new Set());
  });

  /**
   * KAN-148: the dedupe key is still a dedupe key.
   *
   * The link left `comments` for `jira_comment_links`, and the reason it
   * did not become part of the item's JSON extension is exactly this: a
   * JSON column cannot carry a unique index. Two local comments claiming
   * one Jira comment is a comment imported twice, so the insert is
   * refused rather than written — and the comment that asked for it goes
   * with the refusal, because both are in one transaction.
   */
  it("refuse a second comment claiming a Jira comment another one holds", () => {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "From Jira.", jiraCommentId: "10501" });

    expect(() => postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "From Jira, again.", jiraCommentId: "10501" })).toThrow(
      /UNIQUE/i,
    );

    // Nothing half-landed: the duplicate is not on the thread either.
    expect(listCommentsForItem(handle.db, item.id).filter((entry) => entry.body.includes("again"))).toEqual([]);
    expect(knownJiraCommentIds(handle.db, ["10501"])).toEqual(new Set(["10501"]));
  });
});
