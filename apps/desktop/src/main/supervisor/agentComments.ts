import { CommentToolArgsSchema, type AgentWriteAnswer, type MentionTarget, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment, postOutputComment } from "../db/repos/index.js";
import { computeMentionDepth, MENTION_DEPTH_CAP, resolveAndValidateMentions } from "./escalation.js";

/** The turn a `comment` call was made in: what the comment is filed under, and whose it is. */
export interface CommentingTurn {
  itemId: Uuid;
  runId: Uuid;
  agentId: Uuid;
}

/**
 * What a `comment` call did: the answer the tool gives the agent, and
 * whether the run now ends awaiting the people it mentioned (invariant 9).
 */
export interface AgentCommentOutcome {
  answer: AgentWriteAnswer;
  /** The comment was posted as a blocking one: the turn is to be ended and the run parked for a reply. */
  ends: boolean;
}

/**
 * Posts the comment an agent asked for with the `comment` tool (EO-543).
 *
 * Handed over the agent write bridge as the call is made, not read off
 * the run's event stream once it has been (ARCHITECTURE.md §13.1), so
 * the answer is the post's own: the comment and who was told, or why
 * nothing was posted. A call that is not the shape the tool advertises,
 * or that mentions somebody EO cannot find, is refused here and the
 * agent hears why while it can still fix the call. It used to be the
 * run's problem instead — a correction turn opened on the thread — and a
 * run that could not get it right after one failed.
 *
 * A blocking comment is posted as an `escalation` — or as an output, for
 * the agent whose deliverable it is (EO-298) — and the caller ends the
 * turn; past the mention-depth cap an agent-to-agent escalation is
 * redirected to the person and says so.
 */
export function writeAgentComment(db: Db, turn: CommentingTurn, args: unknown): AgentCommentOutcome {
  const parsed = CommentToolArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ends: false,
      answer: { ok: false, code: "INVALID_ARGUMENT", problem: `The comment was not posted: ${parsed.error.issues.map((issue) => issue.message).join("; ")}.` },
    };
  }
  const resolution = resolveAndValidateMentions(db, parsed.data.mentions);
  if (!resolution.ok) return { ends: false, answer: { ok: false, code: "MENTION_REFUSED", problem: `The comment was not posted. ${resolution.error}` } };

  // An output is the thing itself, and EO does not write in it (EO-298).
  const isOutput = parsed.data.kind === "output";

  if (parsed.data.blocking) {
    let targets: MentionTarget[] = resolution.targets;
    let body = parsed.data.body;
    let redirected = false;
    if (targets.some((target) => target.type === "agent") && computeMentionDepth(db, turn.itemId) >= MENTION_DEPTH_CAP) {
      targets = [{ type: "human" }];
      redirected = true;
      // Said either way — invariant 8 — and for an output beside it rather than in it.
      if (!isOutput) body = `${body}\n\n(Escalation redirected to you: mention-depth cap of ${MENTION_DEPTH_CAP} reached on this ticket.)`;
    }
    const written = {
      itemId: turn.itemId,
      // The run this was written during: what places the comment at a step.
      runId: turn.runId,
      author: { type: "agent", agentId: turn.agentId } as const,
      body,
      mentions: targets,
      // The run ends here, waiting on whoever it names (EO-586).
      endsRun: true,
    };
    // "Here is what I produced, and I am stopping until somebody looks at
    // it" is one comment and two facts: the kind carries the first and
    // the mention the second. The run parks the same way either way.
    const comment = isOutput ? postOutputComment(db, written) : postComment(db, { ...written, kind: "escalation" });
    if (redirected && isOutput) {
      postComment(db, {
        itemId: turn.itemId,
        author: { type: "engine" },
        kind: "note",
        body: `Escalation redirected to you: mention-depth cap of ${MENTION_DEPTH_CAP} reached on this ticket.`,
      });
    }
    return {
      ends: true,
      answer: {
        ok: true,
        text:
          (redirected
            ? `Comment posted. The mention-depth cap of ${MENTION_DEPTH_CAP} is reached on this ticket, so it went to the person instead of the agent you named. `
            : "Comment posted and the people you mentioned have been notified. ") + "Your run ends here; it will resume when someone replies. Stop working now.",
        data: { commentId: comment.id, blocking: true, redirectedToPerson: redirected },
      },
    };
  }

  const written = {
    itemId: turn.itemId,
    runId: turn.runId,
    author: { type: "agent", agentId: turn.agentId } as const,
    body: parsed.data.body,
    mentions: resolution.targets,
    options: parsed.data.options ?? null,
    // An agent writing "@someone" in prose must not open a mention:
    // asking is a `clarification_required` result, and nothing else
    // (KAN-29).
    parseBodyMentions: false,
  };
  // An agent's own output goes through the same door the workspace's
  // does (EO-298): chained to what it supersedes, and current by the same
  // derivation.
  const comment = isOutput ? postOutputComment(db, written) : postComment(db, { ...written, kind: parsed.data.kind });
  return { ends: false, answer: { ok: true, text: "Comment posted. Continue with your work.", data: { commentId: comment.id, blocking: false } } };
}
