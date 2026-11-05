import { readFile } from "node:fs/promises";
import { jiraStateOf, JIRA_ALWAYS_SENT_FIELDS, type JiraBindingConfig, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import {
  getAttachment,
  getItem,
  setAttachmentJiraError,
  setJiraAttachmentId,
  setJiraCommentId,
  saveJiraBinding,
  type OutboxEntry,
} from "../../../db/repos/index.js";
import type { ChannelSender, SendOutcome } from "../../../outbox/drain.js";
import { JiraError, type JiraClient, type JiraField } from "./client.js";
import { jiraForWorkspace, type JiraContext } from "./connection.js";

/**
 * How to say something to Jira (J-04).
 *
 * Only the Jira half lives here. Retry, ordering and giving up belong to
 * the outbox (`outbox/drain.ts`) — they are the same problem whoever is
 * on the other end, and were worth getting right once.
 *
 * Everything here reports the default `note`, never an escalation: a
 * Jira that has fallen behind is a nuisance, not a reason to interrupt
 * someone.
 */
export function createJiraSender(context: JiraContext, onChanged?: (itemId: Uuid) => void): ChannelSender {
  return {
    send: (db, entry) => sendOne(db, context, entry),
    settled: (entry) => {
      if (entry.kind === "attachment_upload" || entry.kind === "attachment_delete") onChanged?.(entry.itemId);
    },
    describe: (entry) => {
      if (entry.kind === "status") return "a status change to Jira";
      if (entry.kind === "comment") return "a comment to Jira";
      if (entry.kind === "attachment_upload") return "an attachment to Jira";
      if (entry.kind === "attachment_delete") return "an attachment deletion to Jira";
      return "a branch name to Jira";
    },
    gaveUpNote: () => "Jira is now behind EO for this ticket. Nothing else is affected.",
  };
}

/**
 * Writes down what a transition asked for, so Settings can offer inputs
 * for it (J-05).
 *
 * Discovered here rather than configured in advance because Jira only
 * describes transitions available from where an issue currently sits —
 * there is no moment in Settings when the whole picture exists. Values
 * already filled in are preserved.
 */
/**
 * The most a Jira comment body may hold.
 *
 * Jira Cloud refuses a comment longer than 32,767 characters, which
 * nothing sent it was ever close to until an output comment could be a
 * whole diff (EO-298). What a refusal costs is worth spelling out,
 * because it is not only the comment: the failure is not `final`, so
 * `drainChannel` marks the *item* blocked and everything queued behind
 * it — the status transition for the move that just happened, the
 * branch note — waits through six backoffs before EO gives up on a push
 * that could never have succeeded.
 *
 * Under the limit rather than at it, since the suffix and Jira's own
 * ADF conversion both add to what is sent.
 */
const MAX_JIRA_COMMENT_CHARS = 30_000;

/**
 * What goes to Jira when what was said is longer than Jira will take.
 *
 * The excerpt and a sentence saying where the rest is. Nothing is lost:
 * the comment is whole on the item, which is where EO's copy of the
 * record lives — Jira holds a mirror of the conversation and always has,
 * and a mirror that says "there is more of this, and here is where"
 * is a better mirror than one that silently never arrived.
 */
export function withinJiraLimit(body: string): string {
  if (body.length <= MAX_JIRA_COMMENT_CHARS) return body;
  return `${body.slice(0, MAX_JIRA_COMMENT_CHARS)}\n\n[${body.length - MAX_JIRA_COMMENT_CHARS} more characters. Jira will not take a comment this long — the whole of it is on this ticket in EO.]`;
}

function rememberRequirement(db: Db, projectId: Uuid, binding: JiraBindingConfig, status: string, wanted: JiraField[]): void {
  const existing = binding.transitionFields ?? {};
  const requires = wanted.map((field) => ({ id: field.id, name: field.name, schemaType: field.schemaType, allowedValues: field.allowedValues }));
  if (JSON.stringify(existing[status]?.requires ?? []) === JSON.stringify(requires)) return;

  saveJiraBinding(db, projectId, {
    transitionFields: { ...existing, [status]: { requires, values: existing[status]?.values ?? {} } },
  });
}

async function sendOne(db: Db, context: JiraContext, entry: OutboxEntry): Promise<SendOutcome> {
  const item = getItem(db, entry.itemId);
  const jira = item ? jiraStateOf(item) : null;
  // Not mirrored any more — disconnected, or the key was cleared.
  // Holding the entry forever helps nobody, and it is not a failure.
  if (!jira?.key) return { ok: false, final: true, error: "this ticket is no longer mirrored to Jira" };
  // Checked here as well as at every enqueue site, because the switch can
  // be thrown *after* an entry was queued (EO-122). Final rather than
  // deferred, for the same reason as the branch above: retrying cannot
  // change it, and holding the entry until somebody switches sync back on
  // would send a status change that is by then several moves stale.
  // Quiet, too — no `notify` — since turning sync off is a deliberate act
  // and a note per queued entry is a run of remarks about it.
  if (!jira.sync) return { ok: false, final: true, error: "this ticket has Jira sync switched off" };

  // By the entry's workspace, which is what the enqueue wrote down and
  // is denormalised precisely so a drain does not have to read the item
  // to find it. One hop to the project whose binding says where this
  // goes (KAN-130).
  const connection = jiraForWorkspace(db, context, entry.workspaceId);
  if (!connection.ok) return { ok: false, final: true, error: connection.reason };

  const key = jira.key;
  try {
    if (entry.kind === "attachment_upload") {
      const localId = entry.payload["attachmentId"];
      if (typeof localId !== "string") return { ok: false, final: true, error: "attachment upload has no local id" };
      const attachment = getAttachment(db, localId as Uuid);
      // It was deleted while queued, or another drain already recorded
      // the remote identity. Either way there is nothing left to send.
      if (!attachment || attachment.jiraAttachmentId) return { ok: true, error: "" };
      const created = await connection.client.uploadAttachment(key, {
        filename: attachment.name,
        mimeType: attachment.mimeType,
        data: await readFile(attachment.path),
      });
      setJiraAttachmentId(db, attachment.id, created.id);
      return { ok: true, error: "" };
    }

    if (entry.kind === "attachment_delete") {
      const remoteId = entry.payload["jiraAttachmentId"];
      if (typeof remoteId !== "string") return { ok: false, final: true, error: "attachment deletion has no Jira id" };
      try {
        await connection.client.deleteAttachment(remoteId);
      } catch (error) {
        // Jira already not having it is the desired completed state. A
        // repeated drain must not turn that into a permanent failure.
        if (!(error instanceof JiraError && error.status === 404)) throw error;
      }
      return { ok: true, error: "" };
    }

    if (entry.kind === "comment") {
      // A module's note says which module in its own body (EO-75); this
      // suffix says which *kind* of author, so "EO" alone would file it
      // under EO's own bookkeeping to anyone reading the issue.
      const authorType = entry.payload["authorType"];
      const author = authorType === "agent" ? "an EO agent" : authorType === "module" ? "an EO module" : "EO";
      const created = await connection.client.addComment(key, `${withinJiraLimit(String(entry.payload["body"] ?? ""))}\n\n— via ${author}`);

      // Record which Jira comment this became, while there is still
      // something that knows: `completePush` deletes this outbox row the
      // moment we return ok, and the payload's `commentId` is the only
      // link back to the local row. Without it a later pull reads EO's
      // own words as new and imports them.
      const localId = entry.payload["commentId"];
      if (created.id && typeof localId === "string") {
        setJiraCommentId(db, localId as Uuid, created.id);
      }
      return { ok: true, error: "" };
    }

    if (entry.kind === "branch") {
      await connection.client.addComment(key, `Branch: ${String(entry.payload["branch"] ?? "")}`);
      return { ok: true, error: "" };
    }

    return await pushStatus(db, connection.client, connection.projectId, connection.binding, key, String(entry.payload["toStepId"]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (entry.kind === "attachment_upload" && typeof entry.payload["attachmentId"] === "string") {
      setAttachmentJiraError(db, entry.payload["attachmentId"] as Uuid, message);
    }
    return { ok: false, error: message };
  }
}

/**
 * Moves the Jira issue to whatever the EO state maps to.
 *
 * The map stores a *status name*, not a transition id, because ids are
 * per Jira project and which ones exist depends on where the issue
 * currently sits. Resolving the id at push time against Jira's own
 * `transitions` endpoint is the only version that keeps working.
 */
async function pushStatus(db: Db, client: JiraClient, projectId: Uuid, binding: JiraBindingConfig, key: string, toStepId: string): Promise<SendOutcome> {
  const statusMap = binding.statusMap;
  const target = typeof statusMap?.[toStepId] === "string" ? String(statusMap[toStepId]) : null;
  // An unmapped state is a deliberate "Jira has no opinion about this
  // one", not a failure — and commenting about it on every transition
  // would bury the thread. Dropped quietly.
  if (!target) return { ok: false, final: true, error: `no Jira status mapped for "${toStepId}"` };

  const available = await client.transitions(key);
  const match = available.find((transition) => transition.toStatus.toLowerCase() === target.toLowerCase());
  if (match) {
    // A transition with a screen — "Resolution is required when moving
    // to Done" — rejects a bare POST, identically, every time (J-05).
    const wanted = match.fields.filter((field) => field.required && !JIRA_ALWAYS_SENT_FIELDS.has(field.id));
    const stored = binding.transitionFields?.[target]?.values ?? {};
    const missing = wanted.filter((field) => stored[field.id] === undefined);

    if (wanted.length > 0) rememberRequirement(db, projectId, binding, target, wanted);

    if (missing.length > 0) {
      return {
        ok: false,
        final: true,
        error: `missing ${missing.map((field) => field.name).join(", ")}`,
        notify: `Jira will not move ${key} to "${target}" without ${missing.map((field) => `**${field.name}**`).join(" and ")}. Retrying cannot help.\n\nSettings → Jira → Transition fields now has ${missing.length === 1 ? "it" : "them"}; fill ${missing.length === 1 ? "it" : "them"} in and later moves will go through.`,
      };
    }

    const send = Object.fromEntries(wanted.map((field) => [field.id, stored[field.id]]));
    await client.transition(key, match.id, wanted.length > 0 ? send : undefined);
    return { ok: true, error: "" };
  }

  // No transition offered — but Jira does not offer a transition *into*
  // the status an issue is already in, so "nothing to do" and "not
  // allowed" look identical from here. Checked only on this path, so
  // the ordinary push stays one request.
  const issue = await client.getIssue(key);
  if (issue.status.toLowerCase() === target.toLowerCase()) return { ok: true, error: "" };

  // Genuinely refused: the workflow does not allow this move from where
  // the issue is. Retrying will not change that, and silence would
  // leave the two systems disagreeing with nobody the wiser.
  const offered = available.map((transition) => transition.toStatus).join(", ");
  return {
    ok: false,
    final: true,
    error: `no transition to "${target}"`,
    notify: `Jira would not move ${key} from "${issue.status}" to "${target}". It offered: ${offered || "nothing"}.\n\nThe EO ticket moved anyway; Jira is behind for this one.`,
  };
}
