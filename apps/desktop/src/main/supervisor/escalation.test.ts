import { LOCAL_PERSON_ID, type Agent, type Comment, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveAgent, createAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { listMentionsForComment, needsAttention, openMentionsForHuman, postComment } from "../db/repos/commentsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { agentMentionChain, computeMentionDepth, MENTION_DEPTH_CAP, resolveAndValidateMentions } from "./escalation.js";

describe("resolveAndValidateMentions", () => {
  let handle: DbHandle;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  it("resolves @user to the human target", () => {
    const result = resolveAndValidateMentions(handle.db, ["user"]);
    expect(result).toEqual({ ok: true, targets: [{ type: "human" }] });
  });

  /**
   * EO-302: and the human target is a person, by the time it is a row.
   *
   * This is the comment tool's own path — `mentions: ["user"]` arrives
   * at `comment_post`, is resolved here, and is handed to `postComment`
   * — so the acceptance criterion is about the whole of it rather than
   * about either half. The token stays a token here on purpose: which
   * person "the human" is, is a fact about the installation and not
   * about the word, and `postComment` is the single write path that
   * knows it. A caller cannot forget, because there is nothing to
   * remember.
   */
  it("writes @user out as a mention of the local person, and the inbox finds it there", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "worktree" });
    const resolved = resolveAndValidateMentions(handle.db, ["user"]);
    expect(resolved.ok).toBe(true);

    const comment = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "Which environment is this for?",
      kind: "escalation",
      mentions: resolved.ok ? resolved.targets : [],
      // The tool posts the body as written, and the mention arrives on
      // the side — so nothing here depends on the `@user` in the text.
      parseBodyMentions: false,
    });

    expect(listMentionsForComment(handle.db, comment.id)).toEqual([
      { commentId: comment.id, targetType: "human", targetId: LOCAL_PERSON_ID, status: "open", addressedBy: null },
    ]);
    expect(openMentionsForHuman(handle.db).map((open) => open.comment.id)).toEqual([comment.id]);
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("resolves a configured agent by role or name", () => {
    const byRole = resolveAndValidateMentions(handle.db, ["implementer"]);
    expect(byRole).toEqual({ ok: true, targets: [{ type: "agent", agentId: implementer.id }] });

    const byName = resolveAndValidateMentions(handle.db, [implementer.name]);
    expect(byName).toEqual({ ok: true, targets: [{ type: "agent", agentId: implementer.id }] });
  });

  it("rejects an unknown mention with an error instead of silently dropping it", () => {
    const result = resolveAndValidateMentions(handle.db, ["not-a-real-agent"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not-a-real-agent");
      expect(result.error).toContain("Valid mentions");
    }
  });

  it("rejects the whole set if any single mention is unknown, even if others are valid", () => {
    const result = resolveAndValidateMentions(handle.db, ["user", "bogus"]);
    expect(result.ok).toBe(false);
  });

  it("an empty mentions array resolves to no targets", () => {
    expect(resolveAndValidateMentions(handle.db, [])).toEqual({ ok: true, targets: [] });
  });

  it("refuses an archived agent, and does not offer it as a name that would have worked", () => {
    // A mention is a request for a dispatch, and an archived agent is
    // dispatched to nothing (EO-186). Refused here rather than accepted
    // and left open: the person or the agent that wrote it finds out
    // where they wrote it, which is the whole of invariant #8.
    const retired = createAgent(handle.db, { name: "Retired Tester", role: "tester", provider: "fake", instructions: "Tests things." });
    archiveAgent(handle.db, retired.id);

    for (const token of ["tester", "Retired Tester"]) {
      const result = resolveAndValidateMentions(handle.db, [token]);

      expect(result.ok, token).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(token);
        // The list of what *would* work must not name it either — an
        // error offering "Retired Tester" as a valid mention reads as a
        // typo on the person's part rather than a retirement.
        const valid = result.error.slice(result.error.indexOf("Valid mentions"));
        expect(valid, token).not.toContain("Retired Tester");
        expect(valid, token).toContain("Implementer");
      }
    }
  });

  it("still resolves a disabled agent, because off is not over", () => {
    // Deliberately unlike archived. Somebody switches an agent off while
    // they work out whether it is helping and back on an hour later, and
    // a question asked in between is still a question for that agent.
    updateAgent(handle.db, implementer.id, { enabled: false });

    expect(resolveAndValidateMentions(handle.db, ["implementer"])).toEqual({
      ok: true,
      targets: [{ type: "agent", agentId: implementer.id }],
    });
  });
});

describe("computeMentionDepth", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let reviewer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const agents = listAgents(handle.db);
    implementer = agents.find((agent) => agent.role === "implementer")!;
    reviewer = agents.find((agent) => agent.role === "reviewer")!;
  });

  afterEach(() => {
    handle.close();
  });

  function escalate(from: Agent, to: Agent): Comment {
    return postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: from.id },
      body: "over to you",
      mentions: [{ type: "agent", agentId: to.id }],
      kind: "escalation",
    });
  }

  it("is 0 with no escalations on the item", () => {
    expect(computeMentionDepth(handle.db, item.id)).toBe(0);
  });

  it("counts consecutive agent-authored escalations", () => {
    escalate(implementer, reviewer);
    escalate(reviewer, implementer);
    expect(computeMentionDepth(handle.db, item.id)).toBe(2);
  });

  it("resets to 0 once a human comments on the item", () => {
    escalate(implementer, reviewer);
    escalate(reviewer, implementer);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "ok I'll take it from here" });

    expect(computeMentionDepth(handle.db, item.id)).toBe(0);
  });

  it("reaches the default cap after MENTION_DEPTH_CAP escalations", () => {
    for (let i = 0; i < MENTION_DEPTH_CAP; i++) {
      escalate(i % 2 === 0 ? implementer : reviewer, i % 2 === 0 ? reviewer : implementer);
    }
    expect(computeMentionDepth(handle.db, item.id)).toBe(MENTION_DEPTH_CAP);
  });
});

/**
 * The design's mention-depth cap, counted (EO-212).
 *
 * Deliberately a separate suite from `computeMentionDepth` above, and
 * deliberately a different count: that one asks "how many escalations
 * has an agent written inside this turn", to decide whether to redirect
 * a blocking one at the human. This asks "how far has the chain of
 * agents answering agents run", which is the thing that spends money
 * unattended.
 */
describe("agentMentionChain", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let reviewer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const agents = listAgents(handle.db);
    implementer = agents.find((agent) => agent.role === "implementer")!;
    reviewer = agents.find((agent) => agent.role === "reviewer")!;
  });

  afterEach(() => {
    handle.close();
  });

  function hop(from: Agent, to: Agent): Comment {
    return postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: from.id },
      body: "over to you",
      mentions: [{ type: "agent", agentId: to.id }],
    });
  }

  it("is empty on an item nobody has mentioned anybody on", () => {
    const asked = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "hello" });

    expect(agentMentionChain(handle.db, item.id, asked.id)).toEqual({ hops: 0, agents: [] });
  });

  it("counts each agent-authored comment naming another agent, and names them in order", () => {
    hop(implementer, reviewer);
    const second = hop(reviewer, implementer);

    expect(agentMentionChain(handle.db, item.id, second.id)).toEqual({
      hops: 2,
      agents: [implementer.name, reviewer.name],
    });
  });

  it("restarts at a human comment — a person stepping in is what makes the exchange legitimate", () => {
    hop(implementer, reviewer);
    hop(reviewer, implementer);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "carry on" });
    const afterwards = hop(implementer, reviewer);

    expect(agentMentionChain(handle.db, item.id, afterwards.id).hops).toBe(1);
  });

  it("does not count a human's own mention of an agent", () => {
    const asked = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@implementer look at this",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    expect(agentMentionChain(handle.db, item.id, asked.id).hops).toBe(0);
  });

  it("does not count an agent mentioning the human — that is the one thing this is trying to produce", () => {
    const asked = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@user which limit?",
      mentions: [{ type: "human" }],
      kind: "escalation",
    });

    expect(agentMentionChain(handle.db, item.id, asked.id).hops).toBe(0);
  });

  it("does not count an agent naming itself — nothing dispatches that either", () => {
    const asked = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "note to self @implementer",
      mentions: [{ type: "agent", agentId: implementer.id }],
    });

    expect(agentMentionChain(handle.db, item.id, asked.id).hops).toBe(0);
  });

  it("counts one comment naming two agents as one hop — that widens the chain, it does not lengthen it", () => {
    const architect = createAgent(handle.db, { name: "Ada", role: "architect", provider: "claude", instructions: "Advise." });
    const asked = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: implementer.id },
      body: "@reviewer @Ada thoughts?",
      mentions: [
        { type: "agent", agentId: reviewer.id },
        { type: "agent", agentId: architect.id },
      ],
    });

    expect(agentMentionChain(handle.db, item.id, asked.id)).toEqual({
      hops: 1,
      agents: [implementer.name, reviewer.name, architect.name],
    });
  });

  it("stops at the comment it is asked about, so a mention deferred by a busy item is judged where it was written", () => {
    const first = hop(implementer, reviewer);
    hop(reviewer, implementer);
    hop(implementer, reviewer);

    expect(agentMentionChain(handle.db, item.id, first.id).hops).toBe(1);
  });

  it("counts the whole chain when the comment is not on the item at all", () => {
    hop(implementer, reviewer);
    const elsewhere = createTestItem(handle.db, { type: "story", title: "Another", stepId: "todo" });
    const stray = postComment(handle.db, { itemId: elsewhere.id, author: { type: "human" }, body: "unrelated" });

    expect(agentMentionChain(handle.db, item.id, stray.id).hops).toBe(1);
  });
});
