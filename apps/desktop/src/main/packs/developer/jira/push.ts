import { jiraStateOf, type Item, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { postComment, queueUnsyncedAttachmentsForItem, updateItem } from "../../../db/repos/index.js";
import { jiraFor, type JiraContext } from "./connection.js";
import { toJiraDescription } from "./description.js";

/**
 * Creating in Jira what EO creates (J-03).
 *
 * Everything here happens *after* the EO item exists, and nothing here
 * can stop it existing. Jira being down, or a required field being
 * missing, must never cost someone the feature they just described — so
 * a failure is reported as a comment on the item (invariant #8) and
 * the work carries on without a key.
 *
 * These are the only writes EO makes to Jira besides J-04's updates.
 */

export interface PushResult {
  key: string | null;
  problem: string | null;
}

/**
 * Creates the Jira issue for a feature and records its key.
 *
 * Refuses to make a second issue for an item that already has one —
 * which is what a feature imported by J-02 is, and what a retried
 * create would otherwise produce.
 */
export async function pushFeature(db: Db, context: JiraContext, item: Item, description: string): Promise<PushResult> {
  const held = jiraStateOf(item).key;
  if (held) return { key: held, problem: null };
  if (!item.projectId) return { key: null, problem: null };

  const connection = jiraFor(db, context, item.projectId);
  if (!connection.ok) return { key: null, problem: connection.reason };

  // Which issue type an EO feature becomes is the *binding's* to say
  // (KAN-130): it was read off the item's repository until this story,
  // which made "what does a feature look like in Jira" a fact about a
  // checkout and gave a project spanning two of them two answers.
  const binding = connection.binding;
  try {
    const created = await connection.client.createIssue({
      projectKey: binding.projectKey!,
      issueType: binding.featureIssueType ?? "Epic",
      summary: item.title,
      description,
      ...(binding.fields ? { fields: binding.fields } : {}),
    });

    updateItem(db, item.id, { jiraKey: created.key, jiraId: created.id });
    // The opening comment existed before Jira supplied a key, so its
    // files could not be queued by postComment. Backfill them now.
    queueUnsyncedAttachmentsForItem(db, item.id);
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: `Created ${created.key} in Jira.`,
    });
    return { key: created.key, problem: null };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    // The feature exists either way. Saying so on the item is what
    // stops this being a silent half-failure someone finds in a week.
    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: `This feature was not created in Jira: ${problem}\n\nIt is otherwise a normal EO feature. Reconnect or fix the problem and it can be created later.`,
    });
    return { key: null, problem };
  }
}

export interface PushStoriesResult {
  created: number;
  problem: string | null;
}

/**
 * Creates one Jira child per approved story (J-03).
 *
 * Only for a feature that is itself in Jira: children of nothing would
 * be loose issues nobody asked for. Each story is independent, so one
 * failure does not abandon the rest — every key that can be recorded is
 * recorded, and what failed is said once, on the feature.
 */
export async function pushStories(db: Db, context: JiraContext, feature: Item, stories: Item[]): Promise<PushStoriesResult> {
  const featureKey = jiraStateOf(feature).key;
  if (!featureKey || !feature.projectId || stories.length === 0) return { created: 0, problem: null };

  const connection = jiraFor(db, context, feature.projectId);
  if (!connection.ok) return { created: 0, problem: connection.reason };

  const binding = connection.binding;
  const failures: string[] = [];
  let created = 0;

  for (const story of stories) {
    if (jiraStateOf(story).key) continue;
    try {
      const issue = await connection.client.createIssue({
        projectKey: binding.projectKey!,
        issueType: binding.storyIssueType ?? "Story",
        summary: story.title,
        // Body and acceptance criteria as one description — the same
        // rendering the pull reads back, so a round trip is not an edit.
        description: toJiraDescription(story),
        parentKey: featureKey,
        ...(binding.fields ? { fields: binding.fields } : {}),
      });
      updateItem(db, story.id, { jiraKey: issue.key, jiraId: issue.id });
      queueUnsyncedAttachmentsForItem(db, story.id);
      created += 1;
    } catch (error) {
      failures.push(`${story.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  postComment(db, {
    itemId: feature.id,
    author: { type: "engine" },
    kind: "note",
    body:
      failures.length === 0
        ? `Created ${created} ${created === 1 ? "issue" : "issues"} under ${featureKey} in Jira.`
        : `Created ${created} of ${stories.length} ${stories.length === 1 ? "issue" : "issues"} under ${featureKey}. These were not created:\n${failures
            .map((line) => `- ${line}`)
            .join("\n")}`,
  });

  return { created, problem: failures.length > 0 ? failures.join("; ") : null };
}

/** Whether a project is set up to mirror what EO creates, which is what the checkbox asks about. */
export function jiraCreateAvailable(db: Db, context: JiraContext, projectId: Uuid | null): boolean {
  return projectId ? jiraFor(db, context, projectId).ok : false;
}
