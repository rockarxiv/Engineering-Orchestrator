import { parsedResultOf, type Comment, type Run, type Uuid } from "@eo/core";
import type { ZodType } from "zod";
import type { Db } from "../db/client.js";
import { getRun, listCommentsForItem } from "../db/repos/index.js";

/**
 * One conversation's thread, read once and asked many questions (EO-552).
 *
 * Drawing a chat asks the same few things of every card in it — which
 * comments its run posted, what was filed under it, which run it came
 * from and what that run returned — and each question used to read the
 * whole thread again, fetch the run again and parse its result again.
 * A view of a hundred cards was a hundred reads of the thread. So a view
 * reads the thread once, makes one of these, and hands it to every
 * question it asks; each question answers from it, and reads only what
 * nobody has read yet, once.
 *
 * Held for one view and no longer. It is what the thread said when it
 * was read, and a caller that writes and then reads again makes a new
 * one. A caller that has none — an approve path asking about one card —
 * gets a fresh one from `threadOf`, which costs exactly the one read it
 * always did.
 */
export interface ConversationThread {
  /** Every comment of the conversation, oldest first — by `(createdAt, id)`. */
  readonly comments: readonly Comment[];
  /** One comment of this thread, or undefined when it holds none by that id. */
  find(commentId: string): Comment | undefined;
  /** What the agent posted on this run here, in posting order. Engine notes on the run are not among them. */
  agentCommentsOf(runId: string | null): readonly Comment[];
  /** What was filed directly under this comment, oldest first. */
  under(commentId: string): readonly Comment[];
  /** The run, read once however many cards ask. */
  run(runId: Uuid | null): Run | undefined;
  /** What the run returned, parsed by this schema once however many cards ask; null when it has no run or does not parse. */
  output<T>(runId: Uuid | null, schema: ZodType<T>): T | null;
}

/** Stable thread order: created_at, then id — a batch is posted in one millisecond, and uuidv7 ids keep it in order. */
function inThreadOrder(a: Comment, b: Comment): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

/**
 * The thread of this conversation, from comments already read or read
 * here when the caller has none.
 */
export function threadOf(db: Db, conversationId: Uuid, read?: readonly Comment[]): ConversationThread {
  const comments = [...(read ?? listCommentsForItem(db, conversationId))].sort(inThreadOrder);
  const byId = new Map(comments.map((comment) => [comment.id as string, comment]));
  let byRun: Map<string, Comment[]> | undefined;
  let byParent: Map<string, Comment[]> | undefined;
  const runs = new Map<string, Run | undefined>();
  const outputs = new Map<ZodType<unknown>, Map<string, unknown>>();

  const thread: ConversationThread = {
    comments,
    find: (commentId) => byId.get(commentId),
    agentCommentsOf(runId) {
      if (runId === null) return [];
      if (!byRun) {
        byRun = new Map();
        for (const comment of comments) {
          if (comment.runId === null || comment.authorType !== "agent") continue;
          const list = byRun.get(comment.runId) ?? [];
          list.push(comment);
          byRun.set(comment.runId, list);
        }
      }
      return byRun.get(runId) ?? [];
    },
    under(commentId) {
      if (!byParent) {
        byParent = new Map();
        for (const comment of comments) {
          if (comment.parentId === null) continue;
          const list = byParent.get(comment.parentId) ?? [];
          list.push(comment);
          byParent.set(comment.parentId, list);
        }
      }
      return byParent.get(commentId) ?? [];
    },
    run(runId) {
      if (runId === null) return undefined;
      if (!runs.has(runId)) runs.set(runId, getRun(db, runId));
      return runs.get(runId);
    },
    output<T>(runId: Uuid | null, schema: ZodType<T>): T | null {
      if (runId === null) return null;
      let parsedBy = outputs.get(schema as ZodType<unknown>);
      if (!parsedBy) outputs.set(schema as ZodType<unknown>, (parsedBy = new Map()));
      if (!parsedBy.has(runId)) {
        const parsed = schema.safeParse(parsedResultOf(thread.run(runId)?.result ?? null));
        parsedBy.set(runId, parsed.success ? parsed.data : null);
      }
      return parsedBy.get(runId) as T | null;
    },
  };
  return thread;
}

/**
 * What this run returned, parsed by this schema — from the thread when
 * the caller is drawing one, so a run behind several cards is parsed
 * once, and read here otherwise.
 */
export function outputOf<T>(db: Db, runId: Uuid | null, schema: ZodType<T>, thread?: ConversationThread): T | null {
  if (thread) return thread.output(runId, schema);
  if (runId === null) return null;
  const parsed = schema.safeParse(parsedResultOf(getRun(db, runId)?.result ?? null));
  return parsed.success ? parsed.data : null;
}

/** The run, from the thread when the caller has one. */
export function runOf(db: Db, runId: Uuid | null, thread?: ConversationThread): Run | undefined {
  if (thread) return thread.run(runId);
  return runId === null ? undefined : getRun(db, runId);
}
