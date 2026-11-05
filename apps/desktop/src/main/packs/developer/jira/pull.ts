import { jiraStateOf, acceptanceCriteriaOf, type Item, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import type { AttachmentStorage } from "../../../attachments/storage.js";
import {
  clearJiraPullPending,
  getItem,
  getJiraBinding,
  isJiraConnected,
  knownJiraCommentIds,
  listJiraBindings,
  listJiraPullPending,
  listItemsIncludingArchived,
  postComment,
  stillMirrors,
  updateItem,
} from "../../../db/repos/index.js";
import type { JiraClient } from "./client.js";
import { jiraFor, type JiraContext } from "./connection.js";
import { splitJiraDescription, toJiraDescription } from "./description.js";
import { syncJiraAttachments } from "./attachments.js";

export interface PullResult {
  /** Comments brought in from Jira that EO did not already have. */
  comments: number;
  /** Fields reconciled — a changed summary or description. */
  edits: number;
  /** Jira files added or removed locally. */
  attachments: number;
  /** Remote files deliberately ignored because they exceed 20 MB. */
  skippedAttachments: number;
  /** Why nothing (or not everything) happened. Null when the pull was clean. */
  problem: string | null;
}

const NOTHING: PullResult = { comments: 0, edits: 0, attachments: 0, skippedAttachments: 0, problem: null };

/** Two pulls read as one — the drain and the sweep, in the schedule's one report. */
export function combinePullResults(results: PullResult[]): PullResult {
  return results.length === 0 ? NOTHING : combine(results);
}

function combine(results: PullResult[]): PullResult {
  const problems = results.map((result) => result.problem).filter((problem): problem is string => problem !== null);
  return {
    comments: results.reduce((total, result) => total + result.comments, 0),
    edits: results.reduce((total, result) => total + result.edits, 0),
    attachments: results.reduce((total, result) => total + result.attachments, 0),
    skippedAttachments: results.reduce((total, result) => total + result.skippedAttachments, 0),
    // Deduplicated: twenty stories on a disconnected project would
    // otherwise report the same sentence twenty times.
    problem: problems.length > 0 ? [...new Set(problems)].join("\n") : null,
  };
}

/** The Jira project a key belongs to — `KAN-10` is `KAN`. A key has no other hyphen (`JiraIssueKeySchema`). */
function jiraProjectOf(jiraKey: string): string {
  return jiraKey.slice(0, jiraKey.indexOf("-"));
}

/**
 * Which project's Jira binding answers for an item (EO-127, KAN-130).
 *
 * Its own project, which since KAN-130 is where the binding lives — the
 * question used to be "which of its repositories", and a feature
 * spanning several had none (KAN-17) while `applyNewFeature` gives every
 * feature it creates no repository at all. That is the whole reason this
 * function existed, and the project answers for all of them.
 *
 * An item on no project falls back to matching the Jira project its key
 * names: `KAN-10` is answered for by whichever binding mirrors `KAN`.
 * Being one deterministic answer is what stops `pullProject` sweeping
 * the same feature once per matching binding.
 */
function askableProjectId(db: Db, item: Item): Uuid | null {
  if (item.projectId !== null) return item.projectId;
  const key = jiraStateOf(item).key;
  if (key === null) return null;
  const wanted = jiraProjectOf(key);
  return listJiraBindings(db).find((binding) => isJiraConnected(binding) && binding.config.projectKey === wanted)?.projectId ?? null;
}

/** The project a child's issue is asked of, or nothing when it has no Jira at all. */
function childProjectOf(db: Db, child: Item): Uuid | null {
  const projectId = askableProjectId(db, child);
  if (projectId === null) return null;
  return isJiraConnected(getJiraBinding(db, projectId)) ? projectId : null;
}

/**
 * Brings an item's Jira issue back into EO (comments and field edits).
 *
 * The direction that did not exist. EO pushed status changes and
 * comments out, and `import.ts` copied an issue in exactly once — a
 * second import of the same key is a no-op — so anything written or
 * corrected in Jira afterwards never arrived.
 *
 * Deliberately not status: the map is EO→Jira and not injective, so
 * inverting it is ambiguous; a move into a state that opens pull
 * requests would fire a real one; and invariant 1 makes the engine the
 * owner of transitions. That wants deciding on its own.
 */
export async function pullItem(db: Db, context: JiraContext, itemId: Uuid, storage?: AttachmentStorage): Promise<PullResult> {
  const item = getItem(db, itemId);
  if (!item) return { ...NOTHING, problem: "That ticket no longer exists." };
  const jira = jiraStateOf(item);
  if (!jira.key) return { ...NOTHING, problem: `${item.key} is not mirrored to a Jira issue.` };
  // The switch gates both directions (EO-122), so this stops before the
  // connection is even resolved. Said out loud rather than returning a
  // clean nothing: somebody asked for this pull by name, and "0 comments,
  // 0 edits" would read as "Jira had nothing new".
  if (!jira.sync) return { ...NOTHING, problem: `${item.key} has Jira sync switched off, so nothing was pulled.` };
  // Resolved once per project rather than once per item. A feature of
  // forty stories on one project is one token read, not forty —
  // `jiraFor` reads a credential off disk every time it is asked.
  const connections = new Map<Uuid, ReturnType<typeof jiraFor>>();
  const connectionFor = (projectId: Uuid): ReturnType<typeof jiraFor> => {
    const known = connections.get(projectId);
    if (known) return known;
    const resolved = jiraFor(db, context, projectId);
    connections.set(projectId, resolved);
    return resolved;
  };

  // Its own project when it has one, so an unbound or broken binding
  // still explains itself in `jiraFor`'s own words. An item on no
  // project is answered for by the binding that mirrors the Jira project
  // its key names (EO-127).
  const askable = askableProjectId(db, item);
  if (askable === null) {
    return {
      ...NOTHING,
      problem: `${item.key} is on no project connected to ${jiraProjectOf(jira.key)} in Jira, so there is nothing to ask.`,
    };
  }

  const connection = connectionFor(askable);
  if (!connection.ok) return { ...NOTHING, problem: connection.reason };

  // Children too, when a feature is what was asked for — each story is
  // its own Jira issue, and "sync this feature" plainly means its work.
  //
  // Each child is judged on its own switch (EO-122): pulling a feature
  // whose sync is on must not drag in a story somebody deliberately
  // silenced, and must not skip its siblings on that account either.
  const children = listItemsIncludingArchived(db).filter((entry) => {
    const child = jiraStateOf(entry);
    return entry.parentId === item.id && child.key !== null && child.sync;
  });
  const results = [await pullOne(db, connection.client, item, undefined, storage)];

  // And each child is asked of *its own* Jira, not the feature's. A
  // child may sit on another project — a plan's stories are moved
  // about — and since EO-127 the feature itself is answered for by
  // whichever binding mirrors the Jira project its key names, which need
  // not be its children's. Handing every child the feature's client
  // would fetch OTHER-3 from the site that has never heard of it: a 404
  // at best, and at worst the wrong issue of the same key read into the
  // wrong item.
  for (const child of children) {
    const childProject = childProjectOf(db, child);
    // No Jira configured for this one at all. Skipped rather than
    // reported, which is what `pullProject` and the pending drain do
    // with the same item: it is not part of the conversation with
    // Jira, rather than a failure worth repeating every minute.
    if (!childProject) continue;

    const childConnection = connectionFor(childProject);
    // Configured and broken — a token that is not on this machine, a
    // site somebody deleted. Worth saying, and worth retrying.
    if (!childConnection.ok) {
      results.push({ ...NOTHING, problem: `${child.key} (${jiraStateOf(child).key}): ${childConnection.reason}` });
      continue;
    }
    results.push(await pullOne(db, childConnection.client, child, undefined, storage));
  }
  return combine(results);
}

/**
 * Every mirrored item on a connected project, in one pass.
 *
 * What the timer runs. One `search` per project asks Jira which issues
 * moved, rather than a `getIssue` per item — a project of forty stories
 * is one request, not forty.
 */
export async function pullProject(db: Db, context: JiraContext, projectId: Uuid, sinceMinutes: number, storage?: AttachmentStorage): Promise<PullResult> {
  const connection = jiraFor(db, context, projectId);
  if (!connection.ok) return { ...NOTHING, problem: connection.reason };

  const mirrored = new Map(
    [
      ...listItemsIncludingArchived(db).filter((item) => item.projectId === projectId),
      // And the mirrored items that are on no project at all: a feature
      // from a plan (EO-127). Without these the sweep is blind to an
      // attached epic whose item was never put on a project — its
      // summary and comments would be read once by the drain and then
      // never again. `askableProjectId` picks exactly one project per
      // item, so two bindings cannot sweep the same epic twice.
      ...listItemsIncludingArchived(db).filter(
        (item) => item.projectId === null && jiraStateOf(item).key !== null && askableProjectId(db, item) === projectId,
      ),
    ]
      // A sync-disabled item is left out of the map entirely, so the
      // sweep treats its issue exactly as it treats somebody else's work
      // in the same Jira project: seen, and not ours (EO-122).
      .flatMap((item) => {
        const jira = jiraStateOf(item);
        return jira.key !== null && jira.sync ? [[jira.key, item] as const] : [];
      }),
  );
  if (mirrored.size === 0) return NOTHING;

  let changed;
  try {
    // A window rather than a stored cursor: a sync that misses a beat —
    // the app was closed, the laptop slept — catches up on the next
    // pass, and there is no cursor to get wrong. Widened well past the
    // interval so a slow tick cannot open a gap.
    changed = await connection.client.search(
      `project = "${connection.binding.projectKey}" AND updated >= "-${Math.max(sinceMinutes * 3, 15)}m"`,
      100,
    );
  } catch (error) {
    return { ...NOTHING, problem: error instanceof Error ? error.message : String(error) };
  }

  const results: PullResult[] = [];
  for (const issue of changed) {
    const item = mirrored.get(issue.key);
    // An issue EO does not mirror is somebody else's work in the same
    // Jira project. Not an error, and not ours to import.
    if (item) results.push(await pullOne(db, connection.client, item, issue, storage));
  }
  return combine(results);
}

/**
 * The items attached since the last tick, read in (EO-127).
 *
 * The other half of the marker `linkJiraKey` and `setJiraSync` write.
 * Attaching happens on synchronous paths that must not call Jira, so
 * the intent is recorded there and the network happens here — the same
 * division `outbox` uses for pushes.
 *
 * `pullItem` each, by name, because the ordinary sweep cannot see
 * these: `pullProject` asks Jira which issues *moved* in the last few
 * minutes, and an issue nobody has touched this week never appears in
 * that answer however long you wait. By name also means a feature drags
 * its already-attached stories in with it, which is what `pullItem`
 * has always meant by "this feature".
 *
 * The marker is cleared only for an item whose pull came back clean, so
 * an attempt made while Jira was unreachable is made again on the next
 * tick rather than losing the backfill. The cost of that is re-reading
 * an issue whose attachment failed to download: comments deduplicate on
 * their Jira id and `reconcileFields` converges once the text agrees, so
 * a repeat is wasted requests rather than a duplicated thread.
 *
 * Sequential, like everything else that talks to Jira here: one slow
 * issue must not become twenty concurrent requests at a server EO
 * shares with the rest of somebody's company.
 */
export async function pullPending(db: Db, context: JiraContext, storage?: AttachmentStorage): Promise<PullResult> {
  const results: PullResult[] = [];
  for (const item of listJiraPullPending(db)) {
    // Nothing to ask yet, and not a failure to announce once a minute
    // for the rest of the session. An item on no project, or on one
    // with no Jira bound, is a state somebody is on their way out of —
    // `pullItem` would refuse it locally and hand back a sentence, and
    // the schedule logs every sentence it gets. The marker keeps
    // waiting, and the pull happens on the first tick after the project
    // is connected.
    const askable = askableProjectId(db, item);
    if (askable === null || !isJiraConnected(getJiraBinding(db, askable))) continue;

    const result = await pullItem(db, context, item.id, storage);
    // Against the key this pull was for, not the item id alone. A
    // item relinked while its old issue was being read holds a marker
    // set for the new issue and never yet acted on, and clearing that
    // would strand it: the ordinary sweep only ever sees issues that
    // moved, and a freshly attached one has not.
    const mirroring = jiraStateOf(item).key;
    if (result.problem === null && mirroring !== null) clearJiraPullPending(db, item.id, mirroring);
    results.push(result);
  }
  return combinePullResults(results);
}

/** Every connected project. The timer's entry point. */
export async function pullEverything(db: Db, context: JiraContext, sinceMinutes: number, storage?: AttachmentStorage): Promise<PullResult> {
  const results: PullResult[] = [];
  for (const binding of listJiraBindings(db)) {
    if (isJiraConnected(binding)) results.push(await pullProject(db, context, binding.projectId, sinceMinutes, storage));
  }
  return results.length === 0 ? NOTHING : combine(results);
}

/**
 * A pull that stopped because the item stopped being about this issue
 * (EO-127).
 *
 * Reported rather than returned as a clean nothing, for two reasons. It
 * is the one outcome where EO deliberately threw away work it had
 * already paid for, which is worth a line in the log; and a problem is
 * what stops `pullPending` treating the attempt as done — belt as well
 * as the braces in `clearJiraPullPending`'s own WHERE clause.
 */
function abandoned(item: Item): PullResult {
  return { ...NOTHING, problem: `${item.key} stopped mirroring ${jiraStateOf(item).key} while that issue was being read, so nothing from it was applied.` };
}

/**
 * One item against its issue. `issue` when the caller already fetched
 * it.
 *
 * Every write here is preceded by `stillMirrors`, because everything
 * between them is a network round trip and EO's write handlers run in
 * the gaps. Relinking an item from KAN-1 to KAN-2 mid-pull would
 * otherwise land KAN-1's comments, title, description and files on an
 * item that now mirrors KAN-2 — an overwrite nobody asked for,
 * recorded in the thread as though Jira had made it.
 *
 * Checked before each write rather than once at the top: the checks cost
 * one indexed row read, and a guard that has to be reasoned about ("no
 * macrotask can run between these two statements") is a guard that stops
 * holding the moment somebody adds an `await` between them.
 */
async function pullOne(db: Db, client: JiraClient, item: Item, prefetched?: Awaited<ReturnType<JiraClient["getIssue"]>>, storage?: AttachmentStorage): Promise<PullResult> {
  try {
    const issue = prefetched ?? (await client.getIssue(jiraStateOf(item).key!));
    if (!stillMirrors(db, item)) return abandoned(item);

    // `pullComments` and `syncJiraAttachments` each await again before
    // writing, so each asks the question once more for itself; what
    // they return when the answer is no is nothing done.
    const comments = await pullComments(db, client, item);
    if (!stillMirrors(db, item)) return abandoned(item);

    const edits = reconcileFields(db, item, issue.summary, issue.description);
    const attachmentResult = storage ? await syncJiraAttachments(db, client, item, storage) : { added: 0, removed: 0, skipped: 0, problems: [] };
    return {
      comments,
      edits,
      attachments: attachmentResult.added + attachmentResult.removed,
      skippedAttachments: attachmentResult.skipped,
      problem: attachmentResult.problems.length > 0 ? attachmentResult.problems.join("\n") : null,
    };
  } catch (error) {
    // Both keys: the reader is looking at the EO item, and the
    // failure is about the Jira issue behind it.
    return { ...NOTHING, problem: `${item.key} (${jiraStateOf(item).key}): ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Jira's comments that EO does not already have.
 *
 * "Already have" covers both directions: one pulled on an earlier sync,
 * and one EO wrote and pushed, whose Jira id was recorded when the push
 * was acknowledged. Without the second, EO would import its own words
 * and then push them again.
 */
async function pullComments(db: Db, client: JiraClient, item: Item): Promise<number> {
  const remote = await client.comments(jiraStateOf(item).key!);
  if (remote.length === 0) return 0;
  // Asked between the answer and the writes, which is where the gap is.
  // Somebody else's issue's comments on this thread would be read as
  // this issue's, and there is nothing in a pulled comment that says
  // which issue it came from.
  if (!stillMirrors(db, item)) return 0;

  const known = knownJiraCommentIds(
    db,
    remote.map((comment) => comment.id),
  );

  let added = 0;
  for (const comment of remote) {
    if (comment.id === "" || known.has(comment.id)) continue;
    postComment(db, {
      itemId: item.id,
      // A Jira commenter is a person, and `human` is the only honest
      // value in a closed union of human/agent/engine. The name is in
      // the body because EO has no notion of a Jira account, and
      // inventing one is a bigger change than this feature.
      author: { type: "human" },
      body: `**${comment.author}** in Jira:\n\n${comment.body}`,
      // Both the record of where it came from and the thing that stops
      // it being pushed straight back.
      jiraCommentId: comment.id,
    });
    added += 1;
  }
  return added;
}

/**
 * Title and description, with Jira winning.
 *
 * The Jira issue is the shared artefact — other people read and edit it
 * — so it is the source of truth for the issue's own text. But an
 * overwrite is never silent: what it replaced goes into the thread, so a
 * local edit made between syncs is recoverable by reading rather than
 * gone.
 */
function reconcileFields(db: Db, item: Item, summary: string, description: string): number {
  const patch: { title?: string; body?: string; spec?: Record<string, unknown> } = {};
  const changes: string[] = [];

  if (summary !== "" && summary !== item.title) {
    patch.title = summary;
    changes.push(`**Title** was:\n\n> ${item.title}`);
  }

  // Only for an item that *has* a body. A feature's is deliberately
  // null — its description became the opening comment at import — so
  // filling it here would "restore" something that was moved on purpose,
  // and hand the product owner the same text twice.
  //
  // Compared against what EO would *write* for this item rather than
  // against the body alone. A story's description in Jira is its body
  // plus its acceptance criteria, so comparing the whole to half of it
  // made every sync look like an edit and folded the criteria into the
  // body, where the item screen then showed them twice.
  if (item.body !== null && description !== "" && description !== toJiraDescription(item)) {
    const remote = splitJiraDescription(description);

    if (remote.body !== "" && remote.body !== item.body) {
      patch.body = remote.body;
      changes.push(`**Description** was:\n\n> ${item.body.replace(/\n/g, "\n> ")}`);
    }

    // The criteria are structured — `spec.acceptance_criteria`, the
    // reviewer's definition of done — but they are also half of what
    // someone reads and edits in Jira, so the same rule applies: Jira
    // wins, and what it replaced stays in the thread. Applying it is
    // also what makes the next sync agree; reporting a difference we
    // never resolve would repeat the same comment every few minutes.
    //
    // Only while Jira still *has* a block. A section someone deleted is
    // not an instruction to drop the definition of done, so that stays
    // quiet rather than guessing.
    const mine = acceptanceCriteriaOf(item);
    if (remote.criteria.length > 0 && remote.criteria.join("\n") !== mine.join("\n")) {
      patch.spec = { ...(item.spec ?? {}), acceptance_criteria: remote.criteria };
      changes.push(
        mine.length === 0
          ? `**Acceptance criteria** came from Jira — EO had none recorded.`
          : `**Acceptance criteria** were:\n\n${mine.map((line) => `> - ${line}`).join("\n")}`,
      );
    }
  }

  if (changes.length === 0) return 0;

  updateItem(db, item.id, patch);
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    body: `Updated from Jira — ${jiraStateOf(item).key} has changed.\n\n${changes.join("\n\n")}`,
  });
  return changes.length;
}
