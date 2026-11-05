import { jiraStateOf, type IpcPayload, type IpcResponse, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { EngineHandle } from "./domainCommands.js";
import { jiraForWorkspace, type JiraContext } from "../packs/developer/jira/connection.js";
import { importIssue, looksLikeKey, previewIssue, toJql } from "../packs/developer/jira/import.js";
import { getItem, getJiraBinding, isJiraConnected, postComment, projectForWorkspace } from "../db/repos/index.js";
import { syncJiraAttachments } from "../packs/developer/jira/attachments.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * Starting from an issue that already exists (J-02).
 *
 * Searching and previewing only read. `jira:import` writes, and it
 * writes to EO alone — an imported issue is left exactly as it was in
 * Jira, including its children.
 */

/** Jira's own message is what a person can act on; a status code is not. */
function problemOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function searchJira(db: Db, context: JiraContext, input: IpcPayload<"jira:search">): Promise<IpcResponse<"jira:search">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { issues: [], problem: connection.reason };

  try {
    // A key typed in full is a lookup: JQL text search does not match on
    // the key, so searching "ACME-12" would otherwise find nothing.
    if (looksLikeKey(input.query)) {
      const issue = await connection.client.getIssue(input.query.trim().toUpperCase());
      return { issues: [issue], problem: null };
    }

    const issues = await connection.client.search(toJql(connection.binding.projectKey!, input.query), 25);
    return { issues, problem: null };
  } catch (error) {
    return { issues: [], problem: problemOf(error) };
  }
}

export async function previewJiraIssue(db: Db, context: JiraContext, input: IpcPayload<"jira:preview">): Promise<IpcResponse<"jira:preview">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { issue: null, children: [], existingItemId: null, problem: connection.reason };

  try {
    const preview = await previewIssue(db, connection.client, input.key);
    return { ...preview, problem: null };
  } catch (error) {
    return { issue: null, children: [], existingItemId: null, problem: problemOf(error) };
  }
}

export async function importJiraIssue(
  db: Db,
  context: JiraContext,
  engine: EngineHandle | undefined,
  input: IpcPayload<"jira:import">,
  attachmentStorage?: AttachmentStorage,
): Promise<IpcResponse<"jira:import">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { itemId: null, storyCount: 0, alreadyImported: false, problem: connection.reason };

  try {
    // Re-read rather than trusting what the picker was shown: the
    // summary or the children may have changed while the dialog was
    // open, and the import is the moment that matters.
    const preview = await previewIssue(db, connection.client, input.key);
    // The project being shown, so the import appears where the person
    // doing it is looking; and the repository they chose, which on a
    // one-repo project is the only one there is.
    const result = importIssue(db, preview, input.mode, {
      workspaceId: (input.targetProjectId ?? input.repositoryId) as Uuid,
      projectId: activeProjectId(db),
    });

    // Import is locally committed before any file download. A flaky or
    // oversized remote file cannot roll the item back; its problem is
    // reported while successful siblings remain attached.
    const attachmentProblems: string[] = [];
    if (attachmentStorage) {
      const targets = [
        { itemId: result.itemId, issue: preview.issue },
        ...result.storyIds.map((itemId, index) => ({ itemId, issue: preview.children[index] })),
      ];
      for (const target of targets) {
        const item = getItem(db, target.itemId as Uuid);
        if (!item || !target.issue) continue;
        // A fresh import is always syncing — `createItem` defaults it
        // on — but this loop also runs when the issue was *already*
        // imported, and that item may since have been silenced
        // (EO-122). Pulling its files in would be the switch leaking in
        // the inbound direction, which is the half it is easiest to
        // forget. Reported rather than skipped in silence: this is the
        // one thing the person asked for that did not happen.
        if (!jiraStateOf(item).sync) {
          attachmentProblems.push(`${target.issue.key}: ${item.key} has Jira sync switched off, so its files were left alone.`);
          continue;
        }
        try {
          const pulled = await syncJiraAttachments(db, connection.client, item, attachmentStorage);
          attachmentProblems.push(...pulled.problems);
        } catch (error) {
          attachmentProblems.push(`${target.issue.key}: ${problemOf(error)}`);
        }
      }
    }

    // A repository on another project answers to that project's
    // binding, which may be none at all (KAN-19, KAN-130). The item
    // keeps its key and its link either way, but its status will not
    // travel back — said here rather than discovered when nothing moves
    // in Jira (invariant #8).
    const targetProject = projectForWorkspace(db, (input.targetProjectId ?? input.repositoryId) as Uuid);
    if (!result.alreadyImported && !isJiraConnected(targetProject ? getJiraBinding(db, targetProject.id) : undefined)) {
      postComment(db, {
        itemId: result.itemId as Uuid,
        author: { type: "engine" },
        kind: "note",
        body: `${input.key} stays linked, but this repository is not connected to Jira, so EO will not mirror the status back. Connect it in Settings if you want that.`,
      });
    }

    // Imported stories are immediately dispatchable, and waiting out the
    // tick makes a deliberate action feel broken.
    engine?.notifyStateChange();

    return {
      itemId: result.itemId,
      storyCount: result.storyIds.length,
      alreadyImported: result.alreadyImported,
      problem: attachmentProblems.length > 0 ? attachmentProblems.join("\n") : null,
    };
  } catch (error) {
    return { itemId: null, storyCount: 0, alreadyImported: false, problem: problemOf(error) };
  }
}
