import { developerType, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { createItem } from "../db/repos/index.js";

/**
 * The one off-board item a job owns as its thread (EO-304,
 * `ARCHITECTURE.md`, "What a job records", "Conversations").
 *
 * The Discussions precedent reused. Its guards used to post here; since
 * EO-729 they are messages to the job's owner (`ownerMessage.ts`), and
 * nothing writes to a job thread once it is made. The thread is still
 * made, because `jobs.thread_item_id` names it, until the threads are
 * retired.
 */

/**
 * The step a job thread sits on — migration 0078.
 *
 * Its own step on the `discussions` pipeline rather than a
 * conversation's, for 0036's and 0064's reason: the step is what the code
 * keys on. Sharing one would put every job in a conversation room's list
 * and could hand a person a job thread as the room they are typing into.
 *
 * Not in `roles/conversationSteps.ts` with the rooms, because that
 * module answers "which off-board steps hold a *conversation*, and what
 * each one runs" — and a job thread runs nothing. Nothing is ever
 * dispatched against it: it is somewhere to post.
 */
export const JOB_THREAD_STEP = "job-thread";

/** Its own key sequence, for `DISC`'s reason — a thread is not work people quote. */
export const JOB_THREAD_KEY_PREFIX = "JOB";

/**
 * What the thread is called (EO-308), when it is made. Renaming a job
 * no longer retitles it (EO-729): nothing writes to a job thread.
 */
export function jobThreadTitle(name: string): string {
  return `Job: ${name}`;
}

/**
 * Creates the thread for a job about to be made.
 *
 * Throws rather than returning a refusal, exactly as
 * `openAssistConversation` does and for the same reason: the thread is being created, so there is
 * no thread to post the refusal into. An installation whose project has
 * no container type cannot host a job any more than it can host a chat.
 */
export function openJobThread(db: Db, name: string, projectId: Uuid | null): Item {
  const created = createItem(db, {
    // A container type, deliberately and not cosmetically: it is what
    // gives a thread item the read-only shape `openAssistConversation` relies
    // on — the repository itself rather than a worktree, no branch and
    // no pull request. Inherited rather than special-cased.
    type: developerType("feature"),
    title: jobThreadTitle(name),
    stepId: JOB_THREAD_STEP,
    projectId,
    keyPrefix: JOB_THREAD_KEY_PREFIX,
  });
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}
