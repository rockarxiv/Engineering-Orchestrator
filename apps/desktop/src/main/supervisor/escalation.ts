import { sql } from "drizzle-orm";
import { mentionMatches,
  normalizeMentionToken, type MentionTarget, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent, listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, listMentionsForComment } from "../db/repos/commentsRepo.js";
import { comments } from "../db/schema.js";

/** A→B→A loops (ARCHITECTURE.md, "Agent to agent"): default cap on consecutive agent-targeted escalations since the last human reply. */
export const MENTION_DEPTH_CAP = 5;

export type MentionResolution = { ok: true; targets: MentionTarget[] } | { ok: false; error: string };

/**
 * Resolves @user / @<configured agent> tokens. Per the story's guard,
 * an unknown mention rejects the *whole* set rather than silently
 * dropping just that one token — the caller gets an error to act on.
 *
 * An archived agent is not one of them (EO-186). The row is kept so the
 * comments it already wrote still name their author, not so it can be
 * given new work: a mention is a request for a dispatch, and an archived
 * agent is dispatched to nothing. Refused rather than dropped, and
 * refused with the names that would have worked, so the person or the
 * agent that wrote it finds out here instead of watching a mention sit
 * open forever.
 *
 * Disabled agents are deliberately still mentionable. Off is "not right
 * now" — somebody switches an agent off mid-investigation and back on an
 * hour later, and a question asked in between is still a question for
 * that agent. Archived is the end of it, and nothing un-archives.
 */
export function resolveAndValidateMentions(db: Db, tokens: string[]): MentionResolution {
  if (tokens.length === 0) return { ok: true, targets: [] };

  const agents = listAgents(db).filter((agent) => agent.archivedAt === null);
  const targets: MentionTarget[] = [];
  const unknown: string[] = [];

  for (const token of tokens) {
    const normalized = normalizeMentionToken(token);
    if (normalized === "user" || normalized === "human") {
      targets.push({ type: "human" });
      continue;
    }
    const match = agents.find(
      (agent) => mentionMatches(normalized, agent.role) || mentionMatches(normalized, agent.name),
    );
    if (match) {
      targets.push({ type: "agent", agentId: match.id });
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length > 0) {
    const validNames = ["user", ...agents.map((agent) => agent.name)].join(", ");
    return {
      ok: false,
      error: `Unknown mention(s): ${unknown.map((token) => `@${token}`).join(", ")}. Valid mentions: ${validNames}.`,
    };
  }

  return { ok: true, targets };
}

/**
 * Consecutive agent-authored escalation comments on this item since
 * the last human comment (or since the beginning, if none) — how deep
 * the current A→B→A-style chain is.
 */
export function computeMentionDepth(db: Db, itemId: Uuid): number {
  const row = db.get<{ depth: number }>(sql`
    select count(*) as depth
    from ${comments} c
    where c.item_id = ${itemId}
      and c.kind = 'escalation'
      and c.author_type = 'agent'
      and c.created_at > coalesce(
        (select max(created_at) from ${comments} where item_id = ${itemId} and author_type = 'human'),
        0
      )
  `);
  return row?.depth ?? 0;
}

/**
 * One agent-to-agent hop, and who it was between.
 *
 * `hops` is the number of agent-authored comments that named another
 * agent since the last human comment; `agents` is every agent that
 * appears in those hops, in the order they first do — the author of a
 * hop and whoever it named. The names are what a refusal has to say:
 * "three hops" tells a person how long the chain is and nothing at all
 * about who is in it.
 */
export interface AgentMentionChain {
  hops: number;
  agents: string[];
}

/**
 * How deep the unattended agent-to-agent chain on this item runs
 * (EO-212, ARCHITECTURE.md, "Agent to agent").
 *
 * A *hop* is one agent-authored comment naming a different agent. Per
 * comment rather than per mention, deliberately: an agent that names two
 * teammates in one breath has widened the chain, not lengthened it, and
 * counting that as two hops would spend half the allowance on a single
 * message.
 *
 * The count starts after the last human comment, because a person
 * stepping in is the thing that makes a long exchange legitimate — and
 * it is any human comment, including one EO pulled from Jira. A mention
 * *aimed at* a human is never a hop, and neither is an agent naming
 * itself: `findPendingResponses` dispatches neither, so counting them
 * would spend the allowance on chains that cannot run.
 *
 * `throughCommentId` bounds the walk at the comment being weighed, so
 * the answer is that comment's own depth in the chain rather than the
 * thread's current length. It matters because a mention is not always
 * dispatched on the tick it arrives — a busy item defers it — and a
 * request must be judged by the chain it was written into.
 *
 * Not `computeMentionDepth`, which is a different question and stays
 * where it is: that one counts agent-authored *escalations* of any
 * target inside a running turn, to decide whether a blocking escalation
 * should be redirected to the human. This one counts what actually gets
 * dispatched, at the door where dispatch happens.
 */
export function agentMentionChain(db: Db, itemId: Uuid, throughCommentId: Uuid): AgentMentionChain {
  const thread = listCommentsForItem(db, itemId);

  let start = 0;
  for (let i = 0; i < thread.length; i += 1) {
    if (thread[i]!.authorType === "human") start = i + 1;
  }

  const found = thread.findIndex((comment) => comment.id === throughCommentId);
  // Not in the thread at all — deleted under the dispatch, or never on
  // this item. Weighing the whole chain is the safe reading: it can
  // only refuse, and a refusal says so out loud.
  const end = found === -1 ? thread.length - 1 : found;

  const agents: string[] = [];
  let hops = 0;

  for (let i = start; i <= end; i += 1) {
    const comment = thread[i]!;
    if (comment.authorType !== "agent" || comment.authorId === null) continue;
    const named: Uuid[] = [];
    for (const mention of listMentionsForComment(db, comment.id)) {
      if (mention.targetType !== "agent" || mention.targetId === null) continue;
      if (mention.targetId === comment.authorId) continue;
      named.push(mention.targetId);
    }
    if (named.length === 0) continue;

    hops += 1;
    for (const id of [comment.authorId, ...named]) {
      const name = getAgent(db, id)?.name;
      // An agent that has since been deleted outright leaves a hop that
      // still counts and a name nobody can print. The hop is the fact
      // that matters; the roll-call is what it can be.
      if (name !== undefined && !agents.includes(name)) agents.push(name);
    }
  }

  return { hops, agents };
}
