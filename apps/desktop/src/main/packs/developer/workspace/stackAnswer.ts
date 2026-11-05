import { gitStateOf, jiraStateOf, type Item } from "@eo/core";
import { readStackAnswer, resolveStackTarget, type StackAnswer, type StackDependency, type StackTargetDecision } from "./stackDecision.js";
import type { Db } from "../../../db/client.js";
import { answersInThread, answersSinceLastAsk } from "../../../roles/answers.js";
import { refExists } from "./git.js";

/** Injectable so a test does not need a repository on disk to name a branch. */
export type RefChecker = (repoPath: string, ref: string) => Promise<boolean>;

export interface StackAnswerInput {
  db: Db;
  item: Item;
  /** The unmerged dependencies currently tied — what an answer may name. */
  choices: Item[];
  /** Where a named branch has to actually exist (invariant #5). */
  repoPath: string;
  refExists?: RefChecker;
}

/**
 * The stacking decision, with whatever a person has already said about
 * it (KAN-42's tie case).
 *
 * Every place that resolves a stacking target goes through here rather
 * than calling the pure resolver directly, so cutting the branch,
 * rebasing before review and opening the pull request all read the same
 * answer out of the same thread. One of them honouring it and the others
 * not would be worse than none of them doing so: the branch would be cut
 * from what was asked for and the pull request opened against something
 * else.
 *
 * The resolver is called first *without* the answer, and again with it
 * only if the decision turns out to be the question EO asked. That keeps
 * the thread unread on every dispatch that has nothing to ask, and it
 * means the answer can never override a decision EO is capable of making
 * on its own — a dependency that has since merged is not up for debate.
 */
export async function resolveStackTargetWithAnswer(
  db: Db,
  item: Item,
  dependencies: StackDependency[],
  repoPath: string,
  checkRef?: RefChecker,
): Promise<StackTargetDecision> {
  const decision = resolveStackTarget(item, dependencies);
  if (decision.kind !== "escalate" || decision.choices.length === 0) return decision;

  const answer = await recordedStackAnswer({
    db,
    item,
    choices: decision.choices,
    repoPath,
    ...(checkRef ? { refExists: checkRef } : {}),
  });
  if (!answer) return decision;

  return resolveStackTarget(item, dependencies, answer);
}

/**
 * What a person has said about where a tied story should stack, read
 * back out of the thread.
 *
 * Comments are the only communication channel (invariant #4), so this is
 * where the answer lives — there is no stacking-decision table, and
 * adding one would put a second channel next to the one that already
 * works. The cost is that the answer has to be *re-read* on every
 * resolution rather than looked up, which is why the search below is
 * written to be stable rather than clever: the same thread must always
 * produce the same answer, whether it is being read by the step that
 * cuts the branch, the one that rebases before review, or the one that
 * opens the pull request.
 *
 * Newest first, and the first comment that names one of the items on
 * offer — or a branch this repository actually has — wins. A person's
 * most recent word on the subject is their answer, and an older reply
 * cannot outvote it.
 *
 * A reply that says something EO cannot use is not silently skipped past
 * (invariant #8). It comes back as `unusable`, carrying what was said
 * and why, so the escalation that follows quotes it rather than
 * repeating the original question verbatim — which is exactly what made
 * answering "EO-32" look like it had gone unread.
 */
export async function recordedStackAnswer(input: StackAnswerInput): Promise<StackAnswer | undefined> {
  const { db, item, choices, repoPath } = input;
  const checkRef = input.refExists ?? refExists;

  // The shared reader (EO-183), which is where the rules about who counts
  // now live — this function's own copy of them was the original, and a
  // second copy in every module that asks a question was what came of
  // leaving it here.
  //
  // The whole thread rather than only what followed the last escalation,
  // because this reader knows what it asked: a reply naming one of these
  // dependencies is an answer to *this* question whenever it was written,
  // and a later guard escalating about something else must not erase a
  // decision somebody already made.
  const replies = answersInThread(db, item.id);
  if (replies.length === 0) return undefined;

  // Kept for the case where nothing in the thread is usable: the newest
  // reply that at least *tried* to answer is what gets quoted back.
  let rejected: StackAnswer | undefined;

  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const answer = readStackAnswer(replies[index]!.body, choices);
    if (answer === null) continue;

    if (answer.kind === "dependency") {
      if (choices.some((choice) => namesItem(answer.key, choice))) return answer;
      rejected ??= answer;
      continue;
    }

    if (answer.kind === "branch") {
      if (await checkRef(repoPath, answer.branch)) return answer;
      // Verify, don't trust (invariant #5): a branch nobody has is not a
      // start point, and finding that out here beats letting `git
      // worktree add` fail with it halfway through a dispatch.
      rejected ??= {
        kind: "unusable",
        answer: answer.branch,
        problem: `there is no branch or ref named "${answer.branch}" in ${repoPath}.`,
      };
      continue;
    }

    rejected ??= answer;
  }

  // Only ever reported against a reply written *after* EO last asked.
  // Everything before that is a conversation about something else, and
  // quoting it back as a failed answer would be EO putting words in
  // somebody's mouth.
  //
  // Read here rather than above so the thread is walked a second time
  // only on the path that has something to quote — which is the rarer
  // one, and the only one that needs to know when the reply arrived.
  return rejected && answersSinceLastAsk(db, item.id).length > 0 ? rejected : undefined;
}

/** Same rule the resolver applies: EO key, linked Jira key, or branch. */
function namesItem(text: string, item: Item): boolean {
  const candidate = text.trim().toLowerCase();
  return [item.key, jiraStateOf(item).key, gitStateOf(item).branch].some((name) => name !== null && name.toLowerCase() === candidate);
}
