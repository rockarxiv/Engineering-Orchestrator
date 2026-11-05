import { and, count, desc, eq, getTableColumns, gt, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { onProject } from "./projectScope.js";
import {
  LOCAL_PERSON_ID,
  extractMentionTokens,
  mentionMatches,
  normalizeMentionToken,
  parseStoredCommentOptions,
  uuidv7,
  type Comment,
  type CommentAuthorType,
  type CommentKind,
  type CommentMention,
  type CommentOption,
  type MentionTarget,
  type MentionTargetType,
  type OpenMention,
  type RecordCursor,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import {
  notifyCommentPinned,
  notifyCommentPosted,
  notifyCommentsRemoved,
  notifyMentionSettled,
  type SettledMention,
} from "../commentEvents.js";
import { agents, comments, commentMentions, jiraCommentLinks, outbox, items, projects } from "../schema.js";
import { signedInPersonId, viewerFor } from "../../identity/viewer.js";
import { jiraStateFor } from "./itemsRepo.js";
import { deleteAttachmentsForComments, insertAttachments, listAttachmentsForComment, listAttachmentsForComments, queueAttachmentUpload, type CreateAttachmentRecord } from "./attachmentsRepo.js";
import { enqueueOutbox } from "./outboxRepo.js";
import { isReplica } from "../recordRole.js";

/**
 * The comment read, joined to its Jira link (KAN-148).
 *
 * `comments.jira_comment_id` is a row in `jira_comment_links` now, and
 * this projection is what keeps every reader below reading what it
 * always read. Left join: most comments were never in Jira.
 */
const commentColumns = { ...getTableColumns(comments), jiraCommentId: jiraCommentLinks.jiraCommentId };

type CommentRow = typeof comments.$inferSelect & { jiraCommentId: string | null };

/** Every comment read starts here, so none of them can lose the link. */
function selectComments(db: Db) {
  return db.select(commentColumns).from(comments).leftJoin(jiraCommentLinks, eq(jiraCommentLinks.commentId, comments.id));
}

function commentToDomain(row: CommentRow, durableAttachments?: NonNullable<Comment["attachments"]>): Comment {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    authorType: row.authorType as CommentAuthorType,
    authorId: row.authorId as Uuid | null,
    runId: row.runId as Uuid | null,
    parentId: row.parentId as Uuid | null,
    body: row.body,
    kind: row.kind as CommentKind,
    options: parseStoredCommentOptions(row.options),
    attachments: durableAttachments !== undefined ? durableAttachments : row.attachments as NonNullable<Comment["attachments"]>,
    pinned: row.pinned,
    jiraCommentId: row.jiraCommentId,
    createdAt: row.createdAt,
  };
}

function mentionToDomain(row: typeof commentMentions.$inferSelect): CommentMention {
  return {
    commentId: row.commentId as Uuid,
    targetType: row.targetType as CommentMention["targetType"],
    targetId: row.targetId as Uuid | null,
    status: row.status as CommentMention["status"],
    addressedBy: row.addressedBy as Uuid | null,
  };
}

/** Resolves @tokens found in a body against known agents; unresolved tokens are left as plain text. */
function resolveBodyMentions(tx: Db, body: string): MentionTarget[] {
  const tokens = extractMentionTokens(body);
  if (tokens.length === 0) return [];

  // Live agents only (EO-186). An archived agent is dispatched to
  // nothing, so a token naming one is not a mention: it stays plain
  // text, which is what this function already does with every other
  // name it cannot resolve. `resolveAndValidateMentions` refuses the
  // same token where somebody is there to be told — this path also
  // carries comments arriving from Jira and from modules, where there
  // is nobody to tell and a mention nothing will ever answer is the
  // worse outcome.
  const allAgents = tx.select().from(agents).all().filter((agent) => agent.archivedAt === null);
  const targets: MentionTarget[] = [];

  for (const token of tokens) {
    const normalized = normalizeMentionToken(token);
    if (normalized === "user" || normalized === "human") {
      targets.push({ type: "human" });
      continue;
    }
    const match = allAgents.find(
      (agent) => mentionMatches(normalized, agent.role) || mentionMatches(normalized, agent.name),
    );
    if (match) {
      targets.push({ type: "agent", agentId: match.id as Uuid });
    }
    // An unresolved @token is left as plain text, not an error — free text
    // legitimately contains things that look like mentions (see mentions.test.ts).
  }

  return targets;
}

function dedupeMentionTargets(targets: MentionTarget[]): MentionTarget[] {
  const seen = new Set<string>();
  const result: MentionTarget[] = [];
  for (const target of targets) {
    // A named person is their own target (EO-533: a notice on the record
    // mentions each of the organisation's admins); the unnamed "human" is
    // one target however often it is written. `postComment` drops a named
    // person who turns out to be the one the unnamed target resolves to.
    const key = target.type === "human" ? (target.personId === undefined ? "human" : `human:${target.personId}`) : `agent:${target.agentId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(target);
    }
  }
  return result;
}

/**
 * Marks open mentions as addressed by `comment`, when they target the
 * SAME identity that just posted. This is the whole guard for "agents
 * cannot resolve a human mention": targetType here is always exactly the
 * poster's own authorType, so an agent-authored comment can structurally
 * never touch a target_type='human' row — only a human-authored comment
 * ever does.
 *
 * What it reaches is narrower than the item, because "somebody said
 * something here" is not the same as "somebody answered this":
 *
 * - A reply (D-05) addresses the comment it replies to, and only that
 *   one. Two open questions get two answers; answering the first used to
 *   close the second as well, so an escalation lost its `!` because the
 *   human happened to reply to something else.
 * - A remark at the bottom, replying to nothing in particular, still
 *   clears every open mention on the item. That is the deliberate
 *   convenience it always was: a plain answer typed at the end of the
 *   thread is how an escalation gets resolved and its run resumed, and
 *   a marker that outlived a real answer would be worse than one that
 *   goes early.
 * - A comment EO read *from* Jira closes nothing. Nobody answered in EO;
 *   a sync found someone talking in Jira, about anything at all. That is
 *   how an untouched escalation lost its `!` on a timer.
 */
function resolveMentionsForComment(tx: Db, comment: CommentRow): SettledMention[] {
  // An output answers nothing (EO-298). The convenience above — a
  // remark at the bottom of the thread clears every open mention on the
  // item — is about somebody *saying* something, and posting a
  // deliverable is not saying something. Without this, a person
  // correcting a draft on an item that is parked on an unrelated
  // question takes the `!` off it and marks the question answered,
  // which is the KAN-70 failure wearing a different hat: a marker that
  // outlived nothing, gone before the answer it was waiting for.
  if (comment.kind === "output") return [];
  // Only the two identities a mention can target ever answer one.
  // `engine` posts don't "reply" to anyone, and neither does a `module`
  // (EO-75): a module asks by refusing with options, so a note it leaves
  // must not close a question somebody else is still waiting on.
  if (comment.authorType !== "human" && comment.authorType !== "agent") return [];
  if (comment.jiraCommentId !== null) return []; // pulled from Jira, not written here

  const targetType = comment.authorType; // "human" | "agent"
  // A person answers their own mentions, an agent answers its own
  // (EO-302). `isNull` stood where the person's id is now, which said
  // the same thing while there was one human and no name for them.
  //
  // Who "a person" is stopped being a constant in EO-325. A human
  // comment that names its author answers *that* person's questions —
  // which is how a reply written on Anna's laptop and replayed onto the
  // record closes Anna's mention rather than the record's own implicit
  // one. Unnamed, it is whoever this machine is: the local person in
  // solo mode, the signed-in person after a sign-in.
  //
  // EO-326 is what puts a name on a human comment in the first place: a
  // browser served by a server posts as the person its token belongs
  // to, and `author_id` carries them. The two stories meet exactly here
  // and agree — read the author, fall back to this machine's own answer.
  const answeredBy = comment.authorType === "agent" ? comment.authorId! : (comment.authorId ?? viewerFor(tx, comment.itemId as Uuid));
  const targetIdCondition = eq(commentMentions.targetId, answeredBy);

  const scope =
    comment.parentId !== null
      ? eq(commentMentions.commentId, comment.parentId)
      : sql`${commentMentions.commentId} in (select ${comments.id} from ${comments} where ${comments.itemId} = ${comment.itemId})`;

  // Not a mention on a comment that carries an action (EO-533). Its
  // button opens something — the conflict notice's Fix with assistant —
  // and the mention stands for what that is about, so it is settled by
  // that being settled (`resolveUpdateConflict`) and never by somebody
  // saying something on the thread: a remark about anything else on a
  // project's notes would otherwise take an unresolved conflict out of
  // the inbox, and no later launch would put it back. A reply under the
  // notice is a remark too. Read from the comment's own options, so a
  // replica holding the record's notice and no conflict row keeps the
  // same rule as the record does.
  const carriesAction = sql`${commentMentions.commentId} not in (
    select ${comments.id} from ${comments}, json_each(${comments.options}) as offered
    where ${comments.itemId} = ${comment.itemId} and json_extract(${comments.options}, offered.fullkey || '.kind') = 'open'
  )`;
  const where = and(eq(commentMentions.status, "open"), eq(commentMentions.targetType, targetType), targetIdCondition, scope, carriesAction);
  // Which rows, before they stop being open — the same read `settle`
  // needs on the other two doors, and for the same reason: a `where`
  // that has already run matches nothing.
  const closing = tx.select().from(commentMentions).where(where).all();
  tx.update(commentMentions).set({ status: "addressed", addressedBy: comment.id, settledAt: Date.now() }).where(where).run();
  // Handed back rather than announced from here: this runs inside
  // `postComment`'s transaction, and a listener told about a row its
  // caller may still roll back — on a handle that is the savepoint
  // rather than the database — is told twice wrong. The caller
  // announces once the write is real, which is where the comment's own
  // notification goes off too.
  return settlementsOf(comment.itemId as Uuid, closing, "addressed", comment.id);
}

/**
 * Tells the outbound queue that a mention is over (EO-325).
 *
 * A comment is serialised for the record when it is *posted*, so an
 * escalation went up open and stayed open: answering it a minute later
 * wrote one local row and told nobody. The person saw it answered on
 * the machine they were sitting at, and still waiting on their other
 * one and on their organisation's board.
 *
 * So the three doors that end a mention announce it, and
 * `queueOutbound` turns that into a command. Deliberately not
 * `settleMention`, which is the mirror writing down what the record
 * already decided — announcing there would send the record its own
 * decision back, once per machine that pulled it.
 */
function settlementsOf(
  itemId: Uuid,
  rows: readonly (typeof commentMentions.$inferSelect)[],
  status: string,
  addressedBy: string | null,
): SettledMention[] {
  return rows.map((row) => ({
    commentId: row.commentId as Uuid,
    itemId,
    targetType: row.targetType as "human" | "agent",
    targetId: row.targetId,
    status,
    addressedBy,
  }));
}

function announceSettled(db: Db, settled: readonly SettledMention[]): void {
  for (const one of settled) notifyMentionSettled(db, one);
}

export interface PostCommentInput {
  id?: Uuid;
  itemId: Uuid;
  /**
   * `module` carries no id (EO-75). The module's name lives in the body,
   * because the body is the only part of a comment Jira receives, and a
   * name resolved for the thread and absent from the mirror would be an
   * attribution that stops at the app boundary.
   */
  /**
   * `personId` on a human comment is who said it (EO-326, ARCHITECTURE.md, "Identity").
   *
   * Written into `author_id`, the column an agent's id already uses —
   * "nothing extra is stored", which is what the story asks for: an
   * admin's comment on another team's item is an ordinary comment with
   * their person on it, exactly as anybody else's would be.
   *
   * Absent everywhere there is only one person it could be, which is
   * every desktop, and the column stays null there as it always has.
   * Null therefore reads as "the local person" and not as "unknown" —
   * the same reading `LOCAL_PERSON_ID` has carried since EO-302.
   */
  author: { type: "human"; personId?: Uuid } | { type: "agent"; agentId: Uuid } | { type: "engine" } | { type: "module" };
  body: string;
  mentions?: MentionTarget[]; // explicit, in addition to @token parsing in body
  kind?: CommentKind;
  options?: CommentOption[] | null;
  /** Prepared EO-managed files inserted in the same transaction as this comment. */
  attachmentRecords?: Omit<CreateAttachmentRecord, "itemId" | "commentId">[];
  pinned?: boolean;
  runId?: Uuid | null;
  /** Files this as an answer to another comment (D-05). */
  parentId?: Uuid | null;
  /**
   * Whether `@tokens` in the body become mentions. Default true.
   *
   * False for what an agent writes in a conversation. A mention is a
   * dispatch trigger and an Inbox entry, and neither belongs to a chat:
   * a product owner that types "@user" — which one did, in prose EO
   * never asked for — would put the conversation in the Inbox and light
   * `!` on an item nobody can open, which is exactly what
   * `postAssistReply` mentions nobody in order to avoid. Sanitising
   * the text instead would mean editing what an agent said, and the
   * record is not ours to rewrite; the `@user` stays visible in the
   * message and simply does not summon anyone.
   */
  parseBodyMentions?: boolean;
  /**
   * Whether posting this closes the author's own open questions on the
   * item (EO-325).
   *
   * True everywhere a person or an agent actually says something, which
   * is what it means to answer. False on the one path that is not
   * saying anything — the drain, writing down a comment said on
   * another machine. A replica decides nothing about mentions: the
   * machine that heard the answer closed them and sent that on as its
   * own command, and the record's ruling comes back down the
   * `mentions` list. Re-deriving it here would have this machine close
   * a mention on its own authority, using *its* idea of who "a person"
   * is, and then announce that back up the queue as news.
   */
  resolveMentions?: boolean;
  /**
   * This copy of the comment goes no further than this machine
   * (EO-324, ARCHITECTURE.md, "The record").
   *
   * Everything about it is otherwise ordinary — the mentions are
   * parsed, the inbox sees it, an open question it answers is closed.
   * What it switches off is *carrying it onward*: the Jira mirror, and
   * the command that would queue it for the organisation's record.
   *
   * The two always agree, which is why this is one flag and not two.
   * There are exactly two things it is true of:
   *
   *  - **A comment that arrived from the record.** Anna's desktop wrote
   *    it, pushed it to Jira and sent it to the record; the copy that
   *    reaches Dana's must do neither again, or the issue grows a
   *    duplicate per signed-in machine and the record is told about its
   *    own comment for ever.
   *  - **A comment about this machine.** "Your move of SUP-31 was
   *    superseded by Dana's" is Anna's to read and nobody else's; on
   *    the shared thread it would land in everybody's inbox as a
   *    question about somebody else's mistake.
   *
   * Named for what is true of the comment rather than for the two
   * mechanisms it turns off, so that the next caller has to decide
   * whether their comment stays here rather than whether they would
   * like to be quiet.
   */
  staysHere?: boolean;
  /**
   * This comment ends the run it was written in, which then waits on the
   * people it mentions — an agent's blocking comment (EO-586). Not on the
   * row: an output that blocks and one that does not are the same comment
   * once written, and what tells them apart is this writing of it. Told
   * to the listeners, so a trial item parking this way wakes its
   * conversation as one parking with an escalation does.
   */
  endsRun?: boolean;
  /** When it was written, where that is not now — a comment mirrored from the record. */
  createdAt?: number;
  /**
   * Set only when this comment *came from* Jira.
   *
   * It is also what stops it going back: the outbound enqueue below
   * skips any comment that carries one, so a pulled comment is never
   * pushed to the issue it was read from.
   */
  jiraCommentId?: string;
}

/**
 * What was said on the record after a point, oldest first (EO-324).
 *
 * The comment half of `record:changes`, and the reason invariant #4
 * needs nothing else to sync: outputs are comments and attachments hang
 * off comments (`ARCHITECTURE.md`, "The record"), so one query carries all
 * three.
 *
 * Ordered by `createdAt` then `id` for the reason every other ordered
 * read in this file gives — several comments can share a millisecond
 * and the id is a UUIDv7, so it settles them into the order they were
 * written.
 */
/**
 * `within` scopes the page to one project — see `onProject` (EO-325).
 */
export function listCommentsSince(db: Db, cursor: RecordCursor, limit: number, within?: string): Comment[] {
  const rows = selectComments(db)
    // Strictly after the pair — see `RecordCursor`. A chatty run writes
    // several comments inside one millisecond, so this is the ordinary
    // case rather than the edge.
    .where(
      and(
        sql`(${comments.createdAt} > ${cursor.ts} or (${comments.createdAt} = ${cursor.ts} and ${comments.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(comments.itemId, within),
      ),
    )
    .orderBy(comments.createdAt, comments.id)
    .limit(limit)
    .all();
  return rows.map((row) => commentToDomain(row));
}

/**
 * Pins that changed after a point, oldest first (EO-324, ARCHITECTURE.md, "The record").
 *
 * The third list `record:changes` carries, and the only one that is not
 * about something new. A comment is immutable once written, so the
 * comment feed pages on `created_at` and never revisits a row — which
 * is right for what was said and wrong for the one thing about it that
 * can change afterwards.
 *
 * Its own cursor rather than a re-send of the whole comment: a pin is a
 * boolean, and a desktop catching up on a thread somebody has been
 * curating should not be handed every body again to learn it.
 */
/**
 * `within` scopes the page to one project — see `onProject` (EO-325).
 */
export function listPinsSince(
  db: Db,
  cursor: RecordCursor,
  limit: number,
  within?: string,
): { commentId: Uuid; itemId: Uuid; pinned: boolean; ts: number }[] {
  return db
    .select({ id: comments.id, itemId: comments.itemId, pinned: comments.pinned, pinnedAt: comments.pinnedAt })
    .from(comments)
    .where(
      and(
        sql`${comments.pinnedAt} is not null and (${comments.pinnedAt} > ${cursor.ts} or (${comments.pinnedAt} = ${cursor.ts} and ${comments.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(comments.itemId, within),
      ),
    )
    .orderBy(comments.pinnedAt, comments.id)
    .limit(limit)
    .all()
    .map((row) => ({ commentId: row.id as Uuid, itemId: row.itemId as Uuid, pinned: row.pinned, ts: row.pinnedAt ?? 0 }));
}

/**
 * Mentions that stopped being open since the cursor (EO-325).
 *
 * `listPinsSince`'s twin, one table down, and here for the reason that
 * one is: the comment feed pages on when a comment was *said* and
 * never looks at the row again, which is right for a body nobody edits
 * and wrong for the two things about a thread that change afterwards.
 * Somebody answers an escalation on their laptop; their desktop pulled
 * that comment last week and would never have pulled it again.
 *
 * Paged on `settled_at` and the *row*, not the comment. A mention has
 * no id of its own — it is a comment and a target — and a thread can
 * name four people at once, so a cursor keyed on the comment alone
 * would skip the other three whenever a page boundary landed inside
 * one comment's mentions. The key is spelled out here and returned as
 * `key`, which the device keeps and sends back without reading.
 *
 * `itemId` comes along because the drain needs to know whose board
 * changed without a second read.
 */
export function listSettledMentionsSince(
  db: Db,
  cursor: RecordCursor,
  limit: number,
  within?: string,
): {
  commentId: Uuid;
  itemId: Uuid;
  targetType: "human" | "agent";
  targetId: string | null;
  status: string;
  addressedBy: string | null;
  ts: number;
  key: string;
}[] {
  const key = sql<string>`${commentMentions.commentId} || ':' || ${commentMentions.targetType} || ':' || coalesce(${commentMentions.targetId}, '')`;
  return db
    .select({
      commentId: commentMentions.commentId,
      itemId: comments.itemId,
      targetType: commentMentions.targetType,
      targetId: commentMentions.targetId,
      status: commentMentions.status,
      addressedBy: commentMentions.addressedBy,
      settledAt: commentMentions.settledAt,
      key,
    })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .where(
      and(
        sql`${commentMentions.settledAt} is not null and (${commentMentions.settledAt} > ${cursor.ts} or (${commentMentions.settledAt} = ${cursor.ts} and ${key} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(comments.itemId, within),
      ),
    )
    .orderBy(commentMentions.settledAt, key)
    .limit(limit)
    .all()
    .map((row) => ({
      commentId: row.commentId as Uuid,
      itemId: row.itemId as Uuid,
      targetType: row.targetType as "human" | "agent",
      targetId: row.targetId,
      status: row.status,
      addressedBy: row.addressedBy,
      ts: row.settledAt ?? 0,
      key: row.key,
    }));
}

/** Writes the comment and its mention rows in one transaction (atomic). */
export function postComment(db: Db, input: PostCommentInput): Comment {
  // Whether this installation owns the item, and therefore owns telling
  // the tracker about it (EO-324). A signed-in desktop does not: the
  // record does, once, rather than every desktop that pulls the comment
  // down. See `recordRole.ts`.
  //
  // Of the item, not of the database (EO-325). A kept project's thread
  // is this machine's to mirror; a moved one's is the record's.
  const ours = !isReplica(db, input.itemId);
  const settledHere: SettledMention[] = [];
  const comment = db.transaction((tx) => {
    const row = tx
      .insert(comments)
      .values({
        id: input.id ?? uuidv7(),
        itemId: input.itemId,
        authorType: input.author.type,
        authorId: input.author.type === "agent" ? input.author.agentId : (input.author.type === "human" ? (input.author.personId ?? null) : null),
        runId: input.runId ?? null,
        parentId: input.parentId ?? null,
        body: input.body,
        kind: input.kind ?? "note",
        options: input.options ?? null,
        // Kept only as a migration source for the short-lived Discussions
        // path format. All new files live in the normalized table.
        attachments: [],
        pinned: input.pinned ?? false,
        // The moment it was *written*, which for a mirrored comment is
        // a moment on another machine. Taking `Date.now()` for one of
        // those would reorder a thread on arrival: the replies would
        // sort by when this device heard them rather than by when they
        // were said, and `idx_comments_item` is ordered on exactly this
        // column.
        createdAt: input.createdAt ?? Date.now(),
      })
      .returning()
      .get();

    // The link is its own row now (KAN-148), and its unique index is
    // what refuses a Jira comment EO already holds — in the same
    // transaction as the comment, so a refused link takes the duplicate
    // comment with it rather than leaving it behind unlinked.
    if (input.jiraCommentId !== undefined) {
      tx.insert(jiraCommentLinks).values({ commentId: row.id, jiraCommentId: input.jiraCommentId }).run();
    }
    const posted: CommentRow = { ...row, jiraCommentId: input.jiraCommentId ?? null };

    insertAttachments(tx as unknown as Db, (input.attachmentRecords ?? []).map((attachment) => ({
      ...attachment,
      itemId: input.itemId,
      commentId: row.id as Uuid,
    })));

    const fromBody = input.parseBodyMentions === false ? [] : resolveBodyMentions(tx, input.body);
    const targets = dedupeMentionTargets([...fromBody, ...(input.mentions ?? [])]);
    const written = new Set<string>();
    for (const target of targets) {
      const targetId = target.type === "agent" ? target.agentId : (target.personId ?? viewerFor(tx, input.itemId));
      if (written.has(`${target.type}:${targetId}`)) continue;
      written.add(`${target.type}:${targetId}`);
      tx.insert(commentMentions)
        .values({
          commentId: row.id,
          targetType: target.type,
          // Where a human mention's target is resolved (EO-302, ARCHITECTURE.md, "Identity"):
          // `@user` is the person in front of the app, and in solo mode
          // there is exactly one. Here rather than at each of the seven
          // places that build a `{ type: "human" }` target, because
          // this is the single write path for the row — a caller
          // cannot forget, and the column cannot go back to holding an
          // absence.
          // …and since EO-325, whoever this machine is rather than a
          // constant: `LOCAL_PERSON_ID` on a solo desktop, the
          // signed-in person after a sign-in. A target that names a
          // person outright — which only a comment arriving from the
          // record ever does — is taken as it stands.
          targetId,
          status: "open",
          addressedBy: null,
        })
        .run();
    }

    // A reply resolves the poster's own prior open mentions on this
    // item — unless this is the drain writing down somebody else's,
    // where the answer was already heard elsewhere (EO-325).
    if (input.resolveMentions !== false) settledHere.push(...resolveMentionsForComment(tx, posted));

    // Comments are the only communication channel (invariant #4), so a
    // mirrored item has to carry them. Engine notes stay here: they
    // are EO talking about its own bookkeeping — "created KAN-7 in
    // Jira" read back to you inside KAN-7 is noise at best. A module's
    // note is not that (EO-75): it is something that ran and had
    // something to say, so it mirrors like an agent's.
    // ...and a comment that came *from* Jira is never sent back to it.
    // Without this check a pull re-posts what EO just read, the push
    // appends another "— via EO", and the next pull reads that: an echo
    // that grows a suffix per cycle.
    const item = tx.select().from(items).where(eq(items.id, input.itemId)).get();
    // ...and an item whose Jira sync is switched off says nothing to
    // Jira in either direction (EO-122), key or no key. Both facts are
    // the item's `jira` extension since KAN-148; the repository is still
    // the item's own column.
    const jira = jiraStateFor(tx as unknown as Db, input.itemId);
    if (ours && jira.key && item?.workspaceId && jira.sync && input.author.type !== "engine" && input.jiraCommentId === undefined && input.staysHere !== true) {
      enqueueOutbox(tx as unknown as Db, {
        itemId: input.itemId,
        workspaceId: item.workspaceId as Uuid,
        channel: "jira",
        kind: "comment",
        payload: { commentId: row.id, authorType: row.authorType, body: row.body },
      });
    }

    // Files are issue-level in Jira, even though EO gives them a comment
    // owner. Queue them separately so a comment failure cannot lose the
    // attachment operation, and imported files (which already have a
    // Jira id) naturally skip this path.
    for (const attachment of input.attachmentRecords ?? []) {
      // …and `ours` for the same reason the comment above carries it: a
      // file on a replica reaches the tracker from the record, once,
      // rather than from every machine that holds a copy.
      if (ours && input.staysHere !== true) queueAttachmentUpload(tx as unknown as Db, attachment.id);
    }

    return commentToDomain(posted, listAttachmentsForComment(tx as unknown as Db, row.id as Uuid));
  });

  // After the transaction returns, so a listener that reads the comment
  // back finds it. better-sqlite3 transactions are synchronous, so the
  // row is committed and readable by the time this runs.
  //
  // One caveat, deliberate rather than overlooked: `jira/import.ts`
  // wraps `postComment` in an outer transaction, and better-sqlite3
  // nests via savepoints — so there the notification fires before the
  // outer commit. Harmless, because the push reaches the renderer
  // asynchronously while the outer transaction finishes synchronously in
  // the same tick. An outer rollback costs one wasted refetch.
  notifyCommentPosted(db, comment, { staysHere: input.staysHere === true, endsRun: input.endsRun === true });
  // …and the questions it answered, which travel as their own commands
  // (EO-325): a comment is queued when it is *said*, so the mention it
  // closed would otherwise have stayed open everywhere else for ever.
  //
  // Not gated on `staysHere`, unlike the comment itself. That flag is
  // about this *copy* of what was said, and the mirror is kept out of
  // here by `resolveMentions: false` instead — which is the honest
  // gate, because a note that stays on this machine can still be the
  // thing that answered a question the record is holding open.
  announceSettled(db, settledHere);
  return comment;
}

/**
 * Records which Jira comment a local one became, once a push succeeded.
 *
 * Called from the outbox sender rather than from `postComment`, because
 * the id does not exist until Jira has answered — and by then the only
 * thing holding the link is the outbox payload, which is deleted a
 * moment later.
 */
export function setJiraCommentId(db: Db, commentId: Uuid, jiraCommentId: string): void {
  db.insert(jiraCommentLinks)
    .values({ commentId, jiraCommentId })
    .onConflictDoUpdate({ target: jiraCommentLinks.commentId, set: { jiraCommentId } })
    .run();
}

/**
 * Which of these Jira comments EO already has — pulled before, or
 * written here and pushed there.
 *
 * Asked once per sync rather than once per comment, and answered from
 * the index added with the column.
 */
export function knownJiraCommentIds(db: Db, jiraCommentIds: string[]): Set<string> {
  if (jiraCommentIds.length === 0) return new Set();
  const rows = db
    .select({ jiraCommentId: jiraCommentLinks.jiraCommentId })
    .from(jiraCommentLinks)
    .where(inArray(jiraCommentLinks.jiraCommentId, jiraCommentIds))
    .all();
  return new Set(rows.map((row) => row.jiraCommentId));
}

/** Marks `commentId`'s author's own open mentions on its item as addressed by it. */
export function resolveMentions(db: Db, commentId: Uuid): void {
  const settled = db.transaction((tx) => {
    const comment = selectComments(tx).where(eq(comments.id, commentId)).get();
    if (!comment) {
      throw new Error(`resolveMentions: comment ${commentId} not found`);
    }
    return resolveMentionsForComment(tx, comment);
  });
  announceSettled(db, settled);
}

/**
 * One mention's status, as somewhere else has it (EO-325).
 *
 * The mirror's writer, and the only one that sets a status from
 * *outside* this installation: every other path here is somebody
 * answering or dismissing something on this machine, and each is a
 * statement about what just happened. This is a copy of what already
 * happened elsewhere — a replica pulling a thread, and the record
 * taking a moved project's history — and a row that arrived open
 * because nothing carried its status is an escalation reopening itself
 * in somebody's inbox.
 *
 * Writes nothing where the row is not there. A mention is written with
 * its comment; if that comment did not land, neither did this, and
 * inventing the row here would be a mention on nothing.
 */
export function settleMention(
  db: Db,
  input: { commentId: Uuid; targetType: MentionTargetType; targetId: string | null; status: string; addressedBy: string | null },
): void {
  db.update(commentMentions)
    .set({ status: input.status as never, addressedBy: input.addressedBy, settledAt: input.status === "open" ? null : Date.now() })
    .where(
      and(
        eq(commentMentions.commentId, input.commentId),
        eq(commentMentions.targetType, input.targetType),
        input.targetId === null ? isNull(commentMentions.targetId) : eq(commentMentions.targetId, input.targetId),
      ),
    )
    .run();
}

/**
 * Asks an agent about a comment already written, on this database alone
 * (EO-533) — and only if it was never asked about it here, open or since
 * answered. Answers whether it asked.
 *
 * The one mention that is not written with its comment. A conflict chat's
 * brief is the organisation's record's, copied to every admin's desktop,
 * and a mention travelling with it would have every desktop answer it at
 * once: mention dispatch is each machine's own. So the record writes the
 * brief asking nobody, hands its first turn to one device, and that
 * desktop asks its assistant here. Nothing is announced or queued for
 * the record — the request is this machine's to answer — and settling it
 * later sends the record a status for a row it does not hold, which it
 * ignores (`settleMention`).
 */
export function askAgentAbout(db: Db, commentId: Uuid, agentId: Uuid): boolean {
  const asked = db
    .select()
    .from(commentMentions)
    .where(and(eq(commentMentions.commentId, commentId), eq(commentMentions.targetType, "agent"), eq(commentMentions.targetId, agentId)))
    .get();
  if (asked !== undefined) return false;
  db.insert(commentMentions).values({ commentId, targetType: "agent", targetId: agentId, status: "open", addressedBy: null }).run();
  return true;
}

/** A deliberate stop dismisses the unanswered agent request instead of letting the scheduler immediately restart it. */
export function dismissOpenMentionsForComment(db: Db, commentId: Uuid): void {
  const where = and(eq(commentMentions.commentId, commentId), eq(commentMentions.status, "open"));
  const closing = db.select().from(commentMentions).where(where).all();
  db.update(commentMentions).set({ status: "dismissed", addressedBy: null, settledAt: Date.now() }).where(where).run();
  const itemId = db.select({ itemId: comments.itemId }).from(comments).where(eq(comments.id, commentId)).get()?.itemId;
  if (itemId !== undefined) announceSettled(db, settlementsOf(itemId as Uuid, closing, "dismissed", null));
}

/**
 * Closes one agent's open mention on a comment, leaving every other
 * target on it alone (EO-135).
 *
 * The narrow sibling of `dismissOpenMentionsForComment`, and the reason
 * it is narrow is `@reviewer @user rerun`: EO answering the reviewer's
 * half of that comment must not also clear the human's, because a
 * human mention is what raises `!` on the item (invariant #6). The
 * broad version closes every target on the comment, which is right for
 * a deliberate stop and wrong for this.
 *
 * `dismissed` rather than `addressed`: nothing replied to it. EO read
 * the request and turned it into a run, or declined it in a comment —
 * either way the mention has been dealt with and must not be offered to
 * the scheduler again on the next tick.
 */
export function dismissOpenMentionForAgent(db: Db, commentId: Uuid, agentId: Uuid): void {
  const where = and(
    eq(commentMentions.commentId, commentId),
    eq(commentMentions.status, "open"),
    eq(commentMentions.targetType, "agent"),
    eq(commentMentions.targetId, agentId),
  );
  const closing = db.select().from(commentMentions).where(where).all();
  db.update(commentMentions).set({ status: "dismissed", addressedBy: null, settledAt: Date.now() }).where(where).run();
  const itemId = db.select({ itemId: comments.itemId }).from(comments).where(eq(comments.id, commentId)).get()?.itemId;
  if (itemId !== undefined) announceSettled(db, settlementsOf(itemId as Uuid, closing, "dismissed", null));
}

/**
 * Whose inbox this is, as a predicate (EO-325, EO-326).
 *
 * Three answers, and each belongs to a different asker:
 *
 *  - **absent** — nobody said, so it is *this machine's* inbox, and
 *    EO-325's per-item question decides which of its two identities
 *    holds each row. Every caller on a desktop lands here, and this is
 *    the query unchanged;
 *  - **a person** — a browser served by a server, where the asker is the
 *    device's person rather than the machine's. The machine is a server
 *    and has no "you" of its own to fall back to, so the caller must say
 *    (EO-326, ARCHITECTURE.md, "Identity");
 *  - **`anybody`** — the administrator's cross-project view, which is
 *    the same rows with the person dropped out of the question.
 *
 * One parameter on one query rather than three queries, so the ordering,
 * the joins and the meaning of "open" cannot drift between the readers.
 */
function whoseInbox(db: Db, viewer: Uuid | "anybody" | undefined): SQL[] {
  if (viewer === "anybody") return [];
  if (viewer !== undefined) return [eq(commentMentions.targetId, viewer)];
  return [
    sql`case when ${items.projectId} is null or ${projects.managedAt} is not null
             then ${commentMentions.targetId} = ${signedInPersonId(db)}
             else ${commentMentions.targetId} = ${LOCAL_PERSON_ID} end`,
  ];
}

/** This query IS the inbox — newest first, only what's still open. See `whoseInbox`. */
export function openMentionsForHuman(db: Db, viewer?: Uuid | "anybody"): OpenMention[] {
  return db
    .select({ comment: commentColumns, mention: commentMentions })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .leftJoin(jiraCommentLinks, eq(jiraCommentLinks.commentId, comments.id))
    // By the person's id as well as the type (ARCHITECTURE.md, "Identity"): the inbox is what
    // *you* are being asked, and 7b puts colleagues' rows in this table
    // beside yours.
    //
    // …and *which* of this machine's two identities, per item (EO-325).
    // A desktop that kept one project and moved another answers to two
    // people who are both this person: the organisation's on the work
    // it owns, and the implicit local one on the work that stayed here
    // and was never rewritten. Asking only the first emptied a kept
    // project's inbox silently, which is the failure this join exists
    // to close. On a solo desktop the two ids are one and this reads as
    // it always did.
    .innerJoin(items, eq(items.id, comments.itemId))
    .leftJoin(projects, eq(projects.id, items.projectId))
    .where(
      and(
        eq(commentMentions.targetType, "human"),
        eq(commentMentions.status, "open"),
        ...whoseInbox(db, viewer),
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .all()
    .map((row) => ({ comment: commentToDomain(row.comment, listAttachmentsForComment(db, row.comment.id as Uuid)), mention: mentionToDomain(row.mention) }));
}

/**
 * Derived, never stored (ARCHITECTURE.md, "Needs-attention is derived") — recomputed on every call.
 *
 * **Never true of a preview** (EO-313, ARCHITECTURE.md, "Preview"). The `!` is EO saying a
 * piece of work is stuck on you, and a preview is the one item on the
 * board that nothing depends on: it was made to be watched once and
 * thrown away, and marking it would put a red flag on the very thing a
 * person was told cost nothing. The item's own row rather than the
 * caller's judgement, so the card, the detail and the rail cannot come
 * to different conclusions about the same item.
 *
 * **Nor of a trial item** (EO-582, ARCHITECTURE.md, "Trial pipelines"):
 * the assistant stands in for the person there, and a trial that needs
 * the person says so in the conversation it came from.
 *
 * Only the marker. The preview's inbox *rows* stay — a preview that
 * walks onto a human step has to be answerable, or it stops walking —
 * and it is the inbox's counts that leave them out.
 */
export function needsAttention(db: Db, itemId: Uuid): boolean {
  const row = db.get<{ needsAttention: number }>(sql`
    select exists (
      select 1 from ${commentMentions} m
      join ${comments} c on c.id = m.comment_id
      join ${items} i on i.id = c.item_id
      where c.item_id = ${itemId}
        and i.preview_at is null
        and i.trial_at is null
        and m.target_type = 'human'
        and m.target_id = ${viewerFor(db, itemId)}
        and m.status = 'open'
    ) as "needsAttention"
  `);
  return Boolean(row?.needsAttention);
}

/**
 * The item's output, derived (EO-298, ARCHITECTURE.md, "The output is a comment").
 *
 * The latest comment of kind `output`, computed on every call and stored
 * nowhere — the same arrangement as `needsAttention` above, and for the
 * same reason invariant 6 gives: a derived fact cannot go stale, and a
 * column holding "the current one" is a column something eventually
 * forgets to update. Here that something would be the editor (phase 6),
 * whose whole job is to replace an output an agent wrote moments ago.
 *
 * Ordered the way `listCommentsForItem` orders, id breaking a tie on the
 * millisecond: an edit posted in the same millisecond as the output it
 * supersedes is exactly the case a `created_at` comparison gets wrong,
 * and uuidv7 mints monotonically so that the later id is the later
 * comment.
 *
 * Superseding is a chain rather than a replacement — `parentId` points
 * at what this one replaces — so every earlier output is still in the
 * thread, still readable, and still attributable to whoever wrote it.
 */
export function currentOutputOf(db: Db, itemId: Uuid): Comment | undefined {
  const row = selectComments(db)
    .where(and(eq(comments.itemId, itemId), eq(comments.kind, "output")))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(1)
    .get();
  return row === undefined ? undefined : commentToDomain(row, listAttachmentsForComment(db, row.id as Uuid));
}

/**
 * Posts an output, chained to the one it supersedes.
 *
 * One function rather than a `kind: "output"` at each call site, because
 * the chaining is the part a caller would forget: an output posted with
 * no `parentId` is not wrong in any way a test would catch — it still
 * becomes the current output — it has simply lost the record of what it
 * replaced, which is the one thing the chain exists to keep.
 *
 * A caller may still pass its own `parentId`, and one does: an output an
 * agent posts through the comment tool is a reply to nothing and
 * supersedes whatever was there, exactly like an edit.
 */
export function postOutputComment(db: Db, input: Omit<PostCommentInput, "kind">): Comment {
  const superseded = input.parentId ?? currentOutputOf(db, input.itemId)?.id ?? null;
  return postComment(db, {
    ...input,
    kind: "output",
    parentId: superseded,
    // An output is a document rather than a message, whoever wrote it,
    // so an `@name` in one is text and not an address. A diff carries
    // whatever the code carries; a drafted reply carries whatever the
    // customer's name happens to be. Neither is somebody summoning a
    // colleague, and a mention is a dispatch trigger and an Inbox row.
    // Mentions a caller does intend are passed explicitly and are
    // untouched by this.
    parseBodyMentions: input.parseBodyMentions ?? false,
  });
}

/**
 * Part of a thread, narrowed in the statement that reads it (EO-540).
 *
 * `since` and `pinnedOnly` are terms of the WHERE clause and `newest`
 * its LIMIT, so a caller asking for the last few comments of a long
 * thread is not handed every row, every attachment, to throw most away.
 * Each optional; none set is the whole thread.
 */
export interface CommentWindow {
  /** Only comments created at or after this moment, epoch milliseconds. */
  since?: number | undefined;
  /** Only the pinned ones. `false` is the same as absent, not "only unpinned". */
  pinnedOnly?: boolean | undefined;
  /** Only the newest this many of those, still answered oldest first. */
  newest?: number | undefined;
  /**
   * Only comments older than this one, by the thread's own order (EO-559)
   * — the item page reading back a page before the oldest it holds. A
   * comment that is not in this thread narrows to nothing.
   */
  before?: string | undefined;
  /**
   * Only this comment and those after it, by the same order (EO-559) —
   * the item page holding its start still. Like `before`, a comment
   * not in this thread narrows to nothing.
   */
  from?: string | undefined;
}

/** Stable ordering: created_at, then id as a tiebreaker for same-millisecond comments. */
export function listCommentsForItem(db: Db, itemId: Uuid, window: CommentWindow = {}): Comment[] {
  const narrowed = window.since !== undefined || window.pinnedOnly === true || window.newest !== undefined || window.before !== undefined || window.from !== undefined;
  const rows = !narrowed
    ? selectComments(db).where(eq(comments.itemId, itemId)).orderBy(comments.createdAt, comments.id).all()
    : narrowedComments(db, itemId, window);
  const allAttachments = listAttachmentsForComments(db, rows.map((row) => row.id as Uuid));
  const byComment = new Map<string, NonNullable<Comment["attachments"]>>(rows.map((row) => [row.id, []]));
  for (const attachment of allAttachments) {
    const values = byComment.get(attachment.commentId) ?? [];
    values.push(attachment);
    byComment.set(attachment.commentId, values);
  }
  return rows.map((row) => commentToDomain(row, byComment.get(row.id)));
}

function narrowedComments(db: Db, itemId: Uuid, window: CommentWindow) {
  const older = olderThan(db, itemId, window.before);
  const onward = fromOnward(db, itemId, window.from);
  if (older === null || onward === null) return [];
  const where = and(
    eq(comments.itemId, itemId),
    window.since === undefined ? undefined : gte(comments.createdAt, window.since),
    window.pinnedOnly === true ? eq(comments.pinned, true) : undefined,
    older,
    onward,
  );
  if (window.newest === undefined) return selectComments(db).where(where).orderBy(comments.createdAt, comments.id).all();
  // Newest first so the LIMIT keeps the right end of the thread, then
  // turned back round: a window of a thread still reads top to bottom.
  return selectComments(db).where(where).orderBy(desc(comments.createdAt), desc(comments.id)).limit(window.newest).all().reverse();
}

/**
 * The term "older than this comment" in the thread's order — created_at,
 * then id — or `undefined` where no comment was named. `null` where the
 * one named is not in this item's thread: nothing is older than a
 * comment that is not there.
 */
function olderThan(db: Db, itemId: Uuid, before: string | undefined): SQL | undefined | null {
  if (before === undefined) return undefined;
  const anchor = anchorIn(db, itemId, before);
  if (anchor === undefined) return null;
  return or(lt(comments.createdAt, anchor.createdAt), and(eq(comments.createdAt, anchor.createdAt), lt(comments.id, anchor.id)));
}

/** The term "this comment or after it", read as `olderThan` is. */
function fromOnward(db: Db, itemId: Uuid, from: string | undefined): SQL | undefined | null {
  if (from === undefined) return undefined;
  const anchor = anchorIn(db, itemId, from);
  if (anchor === undefined) return null;
  return or(gt(comments.createdAt, anchor.createdAt), and(eq(comments.createdAt, anchor.createdAt), gte(comments.id, anchor.id)));
}

/** Where a comment of this item's thread stands in its order, or undefined where the thread does not hold it. */
function anchorIn(db: Db, itemId: Uuid, commentId: string): { id: string; createdAt: number } | undefined {
  return db
    .select({ id: comments.id, createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.id, commentId), eq(comments.itemId, itemId)))
    .get();
}

/** Whether this item's thread holds the comment (EO-559). */
export function threadHoldsComment(db: Db, itemId: Uuid, commentId: string): boolean {
  return anchorIn(db, itemId, commentId) !== undefined;
}

/**
 * How many comments an item's thread holds — or, with `before`, how many
 * of them are older than that one (EO-559). Counted in the statement,
 * so a page of a long thread can say how much lies behind it without
 * reading it.
 */
export function countCommentsForItem(db: Db, itemId: Uuid, before?: string): number {
  const older = olderThan(db, itemId, before);
  if (older === null) return 0;
  const row = db.select({ n: count() }).from(comments).where(and(eq(comments.itemId, itemId), older)).get();
  return row?.n ?? 0;
}

/**
 * When each of these threads was last spoken in — its newest comment's
 * stamp — in one statement (EO-552).
 *
 * For a caller weighing many threads by their last word (the assistant's
 * idle expiry, its list of chats), which used to read every comment of
 * every one of them to find a single number each. An item nobody has
 * commented on is absent from the answer.
 */
export function lastCommentAtByItem(db: Db, itemIds: readonly string[]): Map<string, number> {
  if (itemIds.length === 0) return new Map();
  const rows = db
    .select({ itemId: comments.itemId, at: sql<number>`max(${comments.createdAt})` })
    .from(comments)
    .where(inArray(comments.itemId, [...itemIds]))
    .groupBy(comments.itemId)
    .all();
  return new Map(rows.map((row) => [row.itemId, row.at]));
}

/**
 * How a thread opened, without reading the rest of it (EO-552): its
 * first comment, and the first a person posted at its top level rather
 * than under a question. Each is a single row, read through the index
 * the thread is ordered by — what a list naming threads needs, however
 * long any of them has grown. Attachments are as the row records them.
 */
export function threadOpening(db: Db, itemId: Uuid): { first: Comment | undefined; firstFromPerson: Comment | undefined } {
  const first = selectComments(db).where(eq(comments.itemId, itemId)).orderBy(comments.createdAt, comments.id).limit(1).get();
  const firstFromPerson =
    first !== undefined && first.authorType === "human" && first.parentId === null
      ? first
      : selectComments(db)
          .where(and(eq(comments.itemId, itemId), eq(comments.authorType, "human"), isNull(comments.parentId)))
          .orderBy(comments.createdAt, comments.id)
          .limit(1)
          .get();
  return { first: first && commentToDomain(first), firstFromPerson: firstFromPerson && commentToDomain(firstFromPerson) };
}

/** Pinned comments survive context truncation (E-06) — this is how a human marks one as load-bearing. */
export function setCommentPinned(db: Db, commentId: Uuid, pinned: boolean, options: { staysHere?: boolean; at?: number } = {}): void {
  // `pinned_at` is what the record's pull pages on — see the column.
  // The record's own clock is used when one is handed in, so that a pin
  // copied onto a replica keeps the moment it happened rather than the
  // moment it arrived.
  const row = db
    .update(comments)
    .set({ pinned, pinnedAt: options.at ?? Date.now() })
    .where(eq(comments.id, commentId))
    .returning()
    .get();
  // An id nothing matches updates no rows, and announcing a change to a
  // comment that is not here would be telling the record about nothing.
  if (row === undefined) return;
  // Said out loud, so the organisation's record hears about it
  // (EO-324). `staysHere` is the pull applying the record's own pin,
  // which must not be sent back to the record that sent it.
  if (options.staysHere !== true) {
    notifyCommentPinned(db, { commentId, itemId: row.itemId as Uuid, pinned });
  }
}

/** A comment and the replies filed under it — what one delete actually removes. */
export function commentWithReplies(db: Db, id: Uuid): Uuid[] {
  // Threading is one level deep by design (D-05), but this walks anyway:
  // a set that is wrong by one row leaves a foreign key dangling, and
  // the schema does not enforce the depth.
  const children = db.select({ id: comments.id }).from(comments).where(eq(comments.parentId, id)).all();
  return [id, ...children.flatMap((child) => commentWithReplies(db, child.id as Uuid))];
}

/**
 * Removes a comment and its replies for good.
 *
 * Allowed where rewriting a run's history is not (invariant #3): a
 * person asking for something they wrote to be gone is not the engine
 * tidying up after itself, and the same reasoning already lets a whole
 * item go (KAN-30). `run_events` still records that the agent said it.
 *
 * Two consequences are handled here rather than left to drift:
 *
 * - A mention the deleted comment *answered* goes back to open. The
 *   answer no longer exists, so the question is unanswered again, and
 *   `!` derives from exactly this (invariant #6).
 * - A pending Jira push for a deleted comment is dropped. It would
 *   otherwise create, in Jira, a comment that no longer exists here.
 */
export function deleteComment(db: Db, id: Uuid): { deletedIds: Uuid[] } {
  const itemId = db.select({ itemId: comments.itemId }).from(comments).where(eq(comments.id, id)).get()?.itemId;

  const result = db.transaction((tx) => {
    const ids = commentWithReplies(db, id);

    // Before the rows go: a foreign key from a *surviving* mention into
    // one of these is just as dangling as one the other way round.
    tx.update(commentMentions)
      .set({ status: "open", addressedBy: null })
      .where(inArray(commentMentions.addressedBy, ids))
      .run();

    tx.delete(commentMentions).where(inArray(commentMentions.commentId, ids)).run();
    tx.delete(outbox)
      .where(and(eq(outbox.kind, "comment"), inArray(sql`json_extract(${outbox.payload}, '$.commentId')`, ids)))
      .run();
    deleteAttachmentsForComments(tx as unknown as Db, ids);
    tx.delete(comments).where(inArray(comments.id, ids)).run();

    return { deletedIds: ids };
  });

  // After the transaction, for the same reason `postComment` announces
  // after its own: a listener that reads the thread back must see it as
  // it now is. The `!`, the inbox and the dock badge all derive from
  // what just changed.
  if (itemId !== undefined && result.deletedIds.length > 0) notifyCommentsRemoved(db, itemId as Uuid);
  return result;
}

export function getComment(db: Db, id: Uuid): Comment | undefined {
  const row = selectComments(db).where(eq(comments.id, id)).get();
  return row ? commentToDomain(row, listAttachmentsForComment(db, id)) : undefined;
}

/**
 * An open mention of an agent, with what the scheduler needs to decide
 * whether it is work (EO-554): the comment it is on, who wrote it, its
 * words — a rerun request is read from them — and the step its item
 * stands on.
 */
export interface OpenAgentMention {
  itemId: Uuid;
  commentId: Uuid;
  authorType: CommentAuthorType;
  authorId: Uuid | null;
  body: string;
  agentId: Uuid;
  /** The item's step; null only if the item row is gone. */
  stepId: string | null;
}

/**
 * Every open mention of an agent, oldest comment first (EO-554).
 *
 * The scheduler's read, asked on every tick. It used to be one comment
 * read per live item and one mention read per comment — every body of
 * every thread, to find the handful of rows still waiting on an agent.
 * Starting from the mention instead is what `idx_mentions_open` exists
 * for: `status` and `target_type` are its leading columns, so this reads
 * the open agent rows and only then the comments they sit on.
 *
 * Ordered as the per-item walk read them: a thread top to bottom
 * (`listCommentsForItem`'s order), and a comment's mentions by agent id
 * (the primary key's order, which is what `listMentionsForComment`
 * returned within one comment). Across items the caller orders.
 */
export function listOpenAgentMentions(db: Db): OpenAgentMention[] {
  return db.all<OpenAgentMention>(openAgentMentionsQuery());
}

/** The query behind it, exported for the test that holds it to `idx_mentions_open`. */
export function openAgentMentionsQuery(): SQL {
  return sql`
    select c.item_id as "itemId",
           c.id as "commentId",
           c.author_type as "authorType",
           c.author_id as "authorId",
           c.body as "body",
           m.target_id as "agentId",
           i.step_id as "stepId"
    from ${commentMentions} m
    join ${comments} c on c.id = m.comment_id
    left join ${items} i on i.id = c.item_id
    where m.status = 'open'
      and m.target_type = 'agent'
      and m.target_id is not null
    order by c.created_at, c.id, m.target_id
  `;
}

export function listMentionsForComment(db: Db, commentId: Uuid): CommentMention[] {
  return db.select().from(commentMentions).where(eq(commentMentions.commentId, commentId)).all().map(mentionToDomain);
}
