import { developerType, type Item, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { createItem, getItemByJiraKey, listPipelines, postComment, resolveItemType } from "../../../db/repos/index.js";
import type { JiraClient, JiraIssue } from "./client.js";

/**
 * Bringing one Jira issue in (J-02, KAN-19).
 *
 * Deliberately one issue at a time and only when asked. EO does not
 * import a backlog: the point is to start work that already has a key
 * without retyping it, not to keep a second copy of Jira.
 */

/**
 * Where imported work enters: the pipeline's own entry step (ARCHITECTURE.md, "Vocabulary").
 *
 * These used to be four literals — `intake`, `backlog`, `pending_approval`
 * and `todo` — which assumed one pipeline's slugs, and three of which do
 * not exist any more. What remains is one question: does this issue become
 * a feature (a container, on no pipeline at all) or work (which enters
 * where its pipeline says work enters)?
 */
function entryStepFor(db: Db, projectId: Uuid | null): { pipelineId: Uuid; entryStepId: string } | null {
  const pipeline = listPipelines(db, projectId).find((candidate) => candidate.entryStepId !== null);
  return pipeline && pipeline.entryStepId !== null ? { pipelineId: pipeline.id, entryStepId: pipeline.entryStepId } : null;
}

/**
 * What EO should do with the issue — the question the picker asks
 * (KAN-19).
 *
 * Note what it is *not* keyed on: the Jira issue type. A team's Task,
 * Bug, Chore or Spike is as likely to be a finished piece of work as
 * anything called Story, and an Epic is not always a container. What
 * EO can see is whether the issue has children; what it cannot see is
 * whether the words in it are a plan or a request. So it asks, every
 * time, rather than guessing from a type name it does not own.
 */
export type ImportMode =
  /** A request. EO's product owner decomposes it into its own stories. */
  | "plan"
  /** A container whose plan was agreed in Jira: its children become the stories. */
  | "children"
  /** One piece of work, already written. It goes in as it stands and gets worked. */
  | "asWritten";

export interface IssuePreview {
  issue: JiraIssue;
  children: JiraIssue[];
  /** The EO item that already mirrors this issue, if there is one. */
  existingItemId: string | null;
}

/** The issue and what EO already knows about it, so the picker can offer the right choices. */
export async function previewIssue(db: Db, client: JiraClient, key: string): Promise<IssuePreview> {
  const issue = await client.getIssue(key);
  const children = await client.children(key);
  return { issue, children, existingItemId: findByJiraKey(db, key)?.id ?? null };
}

/**
 * Already imported? Picking the same issue twice should open what
 * exists, not make a second copy.
 *
 * Searched across every repository rather than within one (KAN-19). It used
 * to be scoped to the repository the Jira connection belongs to, which was
 * the same repository the item was created in — no longer true now that
 * an imported story can be aimed at a different repository on the same
 * project. Scoped, the second import of ACME-7 would simply not find the
 * first. Unscoped it is also strictly safer: one Jira issue is one piece
 * of work wherever it landed.
 */
export function findByJiraKey(db: Db, key: string): Item | undefined {
  // Archived ones too (KAN-33): an archived item is still an import
  // that happened, and skipping it would create a second copy of the
  // same Jira issue the moment the first was tidied away.
  //
  // The scan this used to do — every item in the database, filtered in
  // memory — became a query when `linkJiraKey` needed the same question
  // answered (EO-122). Same answer, including archived; one place where
  // "which item holds this key" is decided, so import and linking
  // cannot drift apart on it.
  return getItemByJiraKey(db, key);
}

export interface ImportResult {
  /** The one item the issue itself became — a feature, or a story when imported as written. */
  itemId: string;
  /** Its children, when those were imported too. Empty otherwise. */
  storyIds: string[];
  /** True when this issue was already here and nothing new was created. */
  alreadyImported: boolean;
}

/** The engine's line in the thread — why this item is where it is. */
function importNote(preview: IssuePreview, mode: ImportMode): string {
  const childCount = preview.children.length;
  const children = `${childCount} existing ${childCount === 1 ? "child" : "children"}`;

  if (mode === "children") {
    return `Imported from ${preview.issue.key}, with ${children} as stories. No refinement will run — the plan came from Jira.`;
  }
  if (mode === "asWritten") {
    return `Imported from ${preview.issue.key} as written. It will not be decomposed: the product owner checks it can be implemented as it stands, and asks here if it cannot.${
      childCount > 0 ? ` Its ${children} were left in Jira.` : ""
    }`;
  }
  return `Imported from ${preview.issue.key}. ${
    childCount > 0 ? `Its ${children} were left in Jira; EO will work out its own plan.` : "EO will refine it into stories."
  }`;
}

export interface ImportTarget {
  /**
   * The workspace the work happens in — one of them, exactly as every
   * story has (KAN-17).
   *
   * Not necessarily a workspace on the project whose Jira the issue came
   * through: the issue's words say where the work belongs far better
   * than the binding does.
   */
  workspaceId: Uuid;
  /**
   * The project it lands on (KAN-17). Without it an imported item
   * belongs to no project and simply does not appear — which is how this
   * was found: the e2e imported an epic and the stories were nowhere.
   */
  projectId: Uuid | null;
}

/**
 * Turns a picked issue into EO items (J-02, KAN-19).
 *
 * `mode` is the choice the picker asks for, and it decides more than how
 * many items appear:
 *
 * - `children` — a plan already exists and was agreed in Jira, so the
 *   feature skips refinement and parks in the container state with its
 *   stories ready to work.
 * - `plan` — the feature goes to `intake`, where EO's own system agent
 *   picks it up.
 * - `asWritten` — no feature at all. One story, no parent, in `backlog`,
 *   where the product owner checks it rather than decomposing it.
 *
 * The Jira children are left entirely alone in every case.
 */
export function importIssue(db: Db, preview: IssuePreview, mode: ImportMode, target: ImportTarget): ImportResult {
  const { workspaceId, projectId } = target;
  const existing = findByJiraKey(db, preview.issue.key);
  if (existing) return { itemId: existing.id, storyIds: [], alreadyImported: true };

  const description = preview.issue.description.trim();

  // Imported work needs somewhere to land. Refusing here beats creating a
  // item nothing can ever dispatch.
  const placement = entryStepFor(db, projectId);
  if (!placement) throw new Error("This project has no pipeline with an entry step, so there is nowhere to import work to.");

  // And the types it will be imported as, asked for before the
  // transaction opens (KAN-129). Both are checked whichever mode this
  // is, because `children` needs the story type for the issue's
  // children and the container type for the issue itself — finding out
  // halfway would mean rolling back an item somebody can already see in
  // Jira as imported.
  //
  // This pack's, by name: an import produces developer work, and a
  // second pack shipping a `story` of its own would otherwise make the
  // word ambiguous and refuse an import that has nothing to do with it.
  const containerType = resolveItemType(db, projectId, developerType("feature"));
  const workType = resolveItemType(db, projectId, developerType("story"));
  const missing = [containerType, workType].find((resolved) => !resolved.ok);
  // Thrown, like the placement above and for the same reason: this is
  // the shape `importIssue` has always refused in, and the picker turns
  // it into the sentence a person reads.
  if (missing && !missing.ok) throw new Error(missing.problem);

  return db.transaction(() => {
    const created = createItem(db, {
      // A story rather than a feature, so `refine` reaches it as
      // something to check rather than something to break up, and so
      // nothing downstream waits for children it will never have.
      type: developerType(mode === "asWritten" ? "story" : "feature"),
      workspaceId,
      projectId,
      title: preview.issue.summary,
      // Written work carries its specification in `body`, the same as a
      // story EO wrote itself — that is what the implementer reads. A
      // feature's description is a conversation opener instead, and goes
      // into the thread below.
      body: mode === "asWritten" ? description || null : null,
      // A container joins no pipeline; written work enters one (ARCHITECTURE.md, "One work
      // entity").
      ...(mode === "asWritten" ? { pipelineId: placement.pipelineId, stepId: placement.entryStepId } : { pipelineId: null, stepId: null }),
      jiraKey: preview.issue.key,
      jiraId: preview.issue.id,
      // Somebody filed this in Jira, and EO has no person row for them
      // (EO-302). The person who pressed Import did not create it, so
      // naming them would be recording a fact that is not true; null is
      // "EO does not know", which is exactly the case.
      createdBy: null,
    });
    // Resolved a moment ago; the throw is what rolls the import back if
    // it somehow refuses anyway.
    if (!created.ok) throw new Error(created.problem);
    const item = created.item;

    // The description is the opening turn of the conversation, the same
    // shape a described feature has (U-08) — not a `body` field the
    // thread would then contradict. Skipped for written work, which now
    // has it as its body: posting it as well would put the same words in
    // the agent's context twice.
    if (description !== "" && mode !== "asWritten") {
      postComment(db, {
        itemId: item.id,
        author: { type: "human" },
        body: preview.issue.description,
        // These are Jira's own words, read a line above from the issue
        // this item now mirrors. Without saying so, `postComment`
        // queues them straight back to the issue they came from — the
        // import has always pushed each issue's description into itself
        // as a comment. `description:` rather than a comment id because
        // that is what it is: no Jira *comment* exists for it, and the
        // marker only has to be something a pull will never match.
        jiraCommentId: `description:${preview.issue.id}`,
      });
    }

    postComment(db, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "note",
      body: importNote(preview, mode),
    });

    const storyIds =
      mode === "children"
        ? preview.children.map((child) => {
            const story = createItem(db, {
              type: developerType("story"),
              parentId: item.id,
              workspaceId,
              projectId,
              title: child.summary,
              body: child.description || null,
              pipelineId: placement.pipelineId,
              stepId: placement.entryStepId,
              jiraKey: child.key,
              jiraId: child.id,
              createdBy: null,
            });
            if (!story.ok) throw new Error(story.problem);
            return story.item.id;
          })
        : [];

    return { itemId: item.id, storyIds, alreadyImported: false };
  });
}

/**
 * The JQL a search box turns into.
 *
 * Anything containing `=` or `~` is taken as JQL the user wrote; the
 * rest is treated as words to look for. Both are scoped to the
 * configured repository, because a picker that can reach every issue in
 * the instance is a different and much less useful thing.
 */
export function toJql(projectKey: string, query: string): string {
  const trimmed = query.trim();
  const scope = `project = "${projectKey}"`;

  if (trimmed === "") return `${scope} ORDER BY updated DESC`;
  if (/[=~]|\bAND\b|\bORDER BY\b/i.test(trimmed)) return `${scope} AND (${trimmed}) ORDER BY updated DESC`;

  // Quotes would end the string early and change the query's meaning.
  const words = trimmed.replace(/["\\]/g, " ").trim();
  return `${scope} AND (summary ~ "${words}" OR description ~ "${words}") ORDER BY updated DESC`;
}

/** A key typed in full — `ACME-123` — is a lookup, not a text search. */
export function looksLikeKey(query: string): boolean {
  return /^[A-Z][A-Z0-9_]+-\d+$/i.test(query.trim());
}
