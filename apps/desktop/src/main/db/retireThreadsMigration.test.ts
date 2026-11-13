import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, uuidv7, type Message, type Uuid } from "@eo/core";
import { RUN_NOW_OPTION, SKIP_OFFER_OPTIONS } from "../jobs/answer.js";
import { handleMessageHere, openMessagesFor } from "../messages/messages.js";
import { conflictNoticeOptions } from "../gallery/templateUpdates.js";
import { openDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createProject } from "./repos/projectsRepo.js";
import { getItem } from "./repos/itemsRepo.js";
import { getMessage } from "./repos/messagesRepo.js";
import { listOccurrences } from "./repos/jobsRepo.js";
import { listRetiredAttachmentFiles } from "./repos/attachmentsRepo.js";
import { resolveUpdateConflict } from "./repos/pipelineUpdateConflictsRepo.js";
import { appendRunEvent, createRun, listRunsForItem } from "./repos/index.js";
import { createTestItem } from "./testHelpers.js";

/**
 * Migration 0168 (EO-730): the project and job threads retired.
 *
 * Every still-open mention of a person on a thread becomes an open
 * message to that person with the comment's body and options; the
 * threads go with their comments, mentions and files; and what kept
 * them — their steps, the `JOB` sequence, `jobs.thread_item_id` — goes
 * too. The same file runs on a desktop and on the organisation's record.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

let handles: DbHandle[] = [];
let tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles) handle.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  handles = [];
  tempDirs = [];
});

/** A database as it stood on the launch before 0168. */
function beforeTheMigration(): DbHandle {
  const handle = openDb(":memory:");
  handles.push(handle);
  const dir = mkdtempSync(join(tmpdir(), "eo-retire-threads-"));
  tempDirs.push(dir);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith("0168_")));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
  runMigrations(handle.db, dir);
  return handle;
}

const ANNA = "01a1c900-0000-7000-8000-000000000a01" as Uuid;
const BEN = "01a1c900-0000-7000-8000-000000000b02" as Uuid;
/** Ends in the same twelve characters as Ben's id. */
const CARL = "01a1c900-0001-7000-8000-000000000b02" as Uuid;

interface Seeded {
  projectId: Uuid;
  notesId: Uuid;
  jobThreadId: Uuid;
  jobId: string;
  /** A template conflict's notice, mentioning both admins. */
  notice: Uuid;
  conflictId: string;
  /** A note whose one mention was answered already. */
  answered: Uuid;
  /** A person's own reply on the thread, mentioning nobody. */
  reply: Uuid;
  /** A skip's "Run it now" on the job's thread, mentioning its owner. */
  offer: Uuid;
  occurrenceDueAt: number;
  /** A file on the notice's reply. */
  filePath: string;
  /** Ordinary work beside the threads, which stays. */
  work: Uuid;
  /** What the agent that ran on the thread noted about the project. */
  memoryId: string;
}

/**
 * The threads as the code before EO-727 and EO-729 left them. Given an
 * earlier seeding's ids, the threads, comments, job and conflict take
 * them — so a desktop's replica and the record hold one thread between
 * them. (The project is each database's own; a replica's copy would share
 * its id too, which this fixture does not bother to arrange.)
 */
function seed(db: DbHandle["db"], ids?: Partial<Seeded>): Seeded {
  const project = createProject(db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
  db.run(sql`INSERT INTO people (id, name, created_at, is_admin) VALUES (${ANNA}, 'Anna', 1, 1), (${BEN}, 'Ben', 1, 1)`);
  const notes = ids?.notesId ?? (uuidv7() as Uuid);
  const jobThread = ids?.jobThreadId ?? (uuidv7() as Uuid);
  // Filed by today's repository, which reads the column 0170 adds to steps
  // (EO-770): there for the filing, and gone before the upgrade adds it.
  db.run(sql`ALTER TABLE pipeline_steps ADD module_version integer`);
  const work = createTestItem(db, { type: "story", title: "Checkout", stepId: "todo", projectId: project });
  db.run(sql`ALTER TABLE pipeline_steps DROP COLUMN module_version`);
  db.run(sql`INSERT INTO items (id, key, type_id, title, project_id, pipeline_id, step_id, created_at, updated_at)
             VALUES (${notes}, 'SHOP-NOTES', ${work.typeId}, 'Project notes', ${project}, 'discussions', 'project-thread', 1, 1),
                    (${jobThread}, 'JOB-1', ${work.typeId}, 'Job: Monday report', NULL, 'discussions', 'job-thread', 1, 1)`);

  const jobId = ids?.jobId ?? uuidv7();
  db.run(sql`INSERT INTO jobs (id, project_id, name, trigger, pipeline_id, template, owner_id, thread_item_id, created_at, updated_at)
             VALUES (${jobId}, NULL, 'Monday report', '{"kind":"manual"}', 'default',
                     '{"type":"developer:story","title":"{{job}} for {{date}}","body":null}', ${LOCAL_PERSON_ID}, ${jobThread}, 1, 1)`);

  const conflictId = ids?.conflictId ?? uuidv7();
  const notice = comment(db, ids?.notice, notes, "**Delivery** could not take the template's update.", JSON.stringify(conflictNoticeOptions(conflictId)), 10);
  mention(db, notice, ANNA, "open");
  mention(db, notice, BEN, "open");
  db.run(sql`INSERT INTO pipeline_update_conflicts (id, pipeline_id, template_slug, from_version, to_version, base_id, template_id, notes, conflicts, problems, created_at, notice_comment_ids)
             VALUES (${conflictId}, 'default', 'software-feature-to-merge', '1.0', '1.1', 'b', 't', '', '[]', '[]', 1, ${JSON.stringify([notice])})`);

  const answered = comment(db, ids?.answered, notes, "Which repository holds the docs?", JSON.stringify(["api", "web"]), 20);
  mention(db, answered, ANNA, "addressed");
  const reply = comment(db, ids?.reply, notes, "I'll look at it on Monday.", null, 30, notice);
  db.run(sql`INSERT INTO comment_mentions (comment_id, target_type, target_id, status) VALUES (${reply}, 'agent', 'implementer', 'open')`);
  // An agent somebody mentioned there, which ran on the thread.
  const agentId = db.get<{ id: string }>(sql`SELECT id FROM agents LIMIT 1`)!.id;
  const run = createRun(db, { itemId: notes, agentId: agentId as Uuid, action: "respond", status: "succeeded" });
  appendRunEvent(db, run.id, "output", { type: "output", text: "Looking at the notes" });
  const memoryId = uuidv7();
  db.run(sql`INSERT INTO memories (id, scope_kind, scope_id, body, source_kind, source_run_id, source_item_id, project_id, created_at, updated_at)
             VALUES (${memoryId}, 'project', ${project}, 'The docs live in the api repository.', 'run', ${run.id}, ${notes}, ${project}, 1, 1)`);
  const filePath = `/managed/${reply}/notes.txt`;
  db.run(sql`INSERT INTO attachments (id, item_id, comment_id, storage_path, name, mime_type, size, managed, created_at)
             VALUES (${uuidv7()}, ${notes}, ${reply}, ${filePath}, 'notes.txt', 'text/plain', 5, 1, 1)`);

  const offer = comment(db, ids?.offer, jobThread, `"Monday report" was skipped. Run it now?`, JSON.stringify(SKIP_OFFER_OPTIONS), 40);
  mention(db, offer, LOCAL_PERSON_ID, "open");
  const occurrenceDueAt = Date.UTC(2026, 5, 1, 8);
  db.run(sql`INSERT INTO job_occurrences (id, job_id, due_at, fired_at, status, reason, item_id, offer_comment_id)
             VALUES (${uuidv7()}, ${jobId}, ${occurrenceDueAt}, NULL, 'skipped', 'offline beyond grace', NULL, ${offer})`);

  return { projectId: project, notesId: notes, jobThreadId: jobThread, jobId, notice, conflictId, answered, reply, offer, occurrenceDueAt, filePath, work: work.id as Uuid, memoryId };
}

function comment(db: DbHandle["db"], id: Uuid | undefined, itemId: Uuid, body: string, options: string | null, at: number, parentId: Uuid | null = null): Uuid {
  const commentId = id ?? (uuidv7() as Uuid);
  db.run(sql`INSERT INTO comments (id, item_id, author_type, parent_id, body, kind, options, created_at)
             VALUES (${commentId}, ${itemId}, 'engine', ${parentId}, ${body}, 'question', ${options}, ${at})`);
  return commentId;
}

function mention(db: DbHandle["db"], commentId: Uuid, personId: string, status: string): void {
  db.run(sql`INSERT INTO comment_mentions (comment_id, target_type, target_id, status) VALUES (${commentId}, 'human', ${personId}, ${status})`);
}

function messages(db: DbHandle["db"]): Message[] {
  return db.all<{ id: string }>(sql`SELECT id FROM messages ORDER BY created_at, recipient_id`).map((row) => getMessage(db, row.id)!);
}

describe("migration 0168, retiring the project and job threads", () => {
  it("turns every open mention of a person on a thread into an open message to that person, with the comment's body and options", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);

    runMigrations(handle.db, MIGRATIONS);

    const sent = messages(handle.db);
    expect(sent.map((message) => [message.recipientId, message.source])).toEqual([
      [ANNA, "template_conflict"],
      [BEN, "template_conflict"],
      [LOCAL_PERSON_ID, "job_skipped"],
    ]);
    for (const message of sent) expect(message).toMatchObject({ handledAt: null, handledHow: null, answer: null });
    const [toAnna, toBen, offer] = sent;
    expect(toAnna).toMatchObject({ projectId: seeded.projectId, jobId: null, body: "**Delivery** could not take the template's update.", options: conflictNoticeOptions(seeded.conflictId), createdAt: 10 });
    expect(toBen).toMatchObject({ projectId: seeded.projectId, body: toAnna!.body, options: toAnna!.options });
    expect(offer).toMatchObject({ projectId: null, jobId: seeded.jobId, body: `"Monday report" was skipped. Run it now?`, options: SKIP_OFFER_OPTIONS, createdAt: 40 });
    // The first mention of a comment keeps the comment's id; the others
    // the comment's and the person's together.
    expect(toAnna!.id).toBe(seeded.notice);
    expect(toBen!.id).toBe(`${seeded.notice}:${BEN}`);
    // In the inbox of the person at this desktop.
    expect(openMessagesFor(handle.db, undefined).map((message) => message.id)).toEqual([offer!.id]);
  });

  it("gives every person mentioned on one comment a message of their own, however alike their ids", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);
    handle.db.run(sql`INSERT INTO people (id, name, created_at, is_admin) VALUES (${CARL}, 'Carl', 1, 1)`);
    mention(handle.db, seeded.notice, CARL, "open");

    runMigrations(handle.db, MIGRATIONS);

    const aboutTheConflict = messages(handle.db).filter((message) => message.source === "template_conflict");
    expect(aboutTheConflict.map((message) => [message.recipientId, message.id])).toEqual([
      [ANNA, seeded.notice],
      [BEN, `${seeded.notice}:${BEN}`],
      [CARL, `${seeded.notice}:${CARL}`],
    ]);
  });

  it("names a mention's message the same however far its status had got, so a lagging replica and the record agree", () => {
    const record = beforeTheMigration();
    const replica = beforeTheMigration();
    const onTheRecord = seed(record.db);
    seed(replica.db, onTheRecord);
    // Anna answered on the record; the replica has not heard yet.
    record.db.run(sql`UPDATE comment_mentions SET status = 'addressed' WHERE comment_id = ${onTheRecord.notice} AND target_id = ${ANNA}`);

    runMigrations(record.db, MIGRATIONS);
    runMigrations(replica.db, MIGRATIONS);

    const toBen = (db: DbHandle["db"]) => messages(db).find((message) => message.recipientId === BEN)?.id;
    expect(toBen(record.db)).toBe(`${onTheRecord.notice}:${BEN}`);
    expect(toBen(replica.db)).toBe(toBen(record.db));
  });

  it("keeps what an agent that ran on a thread noted, pointing at neither the run nor the thread", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);

    runMigrations(handle.db, MIGRATIONS);

    expect(handle.db.get(sql`SELECT body, source_run_id, source_item_id FROM memories WHERE id = ${seeded.memoryId}`)).toEqual({
      body: "The docs live in the api repository.",
      source_run_id: null,
      source_item_id: null,
    });
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("deletes the threads with every comment, mention and file on them, and leaves other work alone", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);

    runMigrations(handle.db, MIGRATIONS);

    expect(getItem(handle.db, seeded.notesId)).toBeUndefined();
    expect(getItem(handle.db, seeded.jobThreadId)).toBeUndefined();
    expect(handle.db.all(sql`SELECT id FROM comments`)).toEqual([]);
    expect(handle.db.all(sql`SELECT comment_id FROM comment_mentions`)).toEqual([]);
    expect(handle.db.all(sql`SELECT id FROM attachments`)).toEqual([]);
    expect(listRunsForItem(handle.db, seeded.notesId)).toEqual([]);
    expect(handle.db.all(sql`SELECT seq FROM run_events`)).toEqual([]);
    // Its bytes are left for the launch to remove.
    expect(listRetiredAttachmentFiles(handle.db)).toEqual([seeded.filePath]);
    expect(getItem(handle.db, seeded.work)?.title).toBe("Checkout");
    // The job stays, and what it has done.
    expect(handle.db.get(sql`SELECT name FROM jobs WHERE id = ${seeded.jobId}`)).toEqual({ name: "Monday report" });
    expect(listOccurrences(handle.db, seeded.jobId as Uuid)).toHaveLength(1);
  });

  it("removes what kept them: their steps, the JOB sequence, the one-per-project index and jobs.thread_item_id", () => {
    const handle = beforeTheMigration();
    seed(handle.db);

    runMigrations(handle.db, MIGRATIONS);

    expect(handle.db.all(sql`SELECT id FROM pipeline_steps WHERE id IN ('project-thread', 'job-thread')`)).toEqual([]);
    expect(handle.db.all(sql`SELECT prefix FROM key_counters WHERE prefix = 'JOB'`)).toEqual([]);
    expect(handle.db.all(sql`SELECT name FROM sqlite_master WHERE name = 'idx_items_project_thread'`)).toEqual([]);
    expect(handle.db.all<{ name: string }>(sql`PRAGMA table_info('jobs')`).map((column) => column.name)).not.toContain("thread_item_id");
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("changes nothing when it runs again", () => {
    const handle = beforeTheMigration();
    seed(handle.db);
    runMigrations(handle.db, MIGRATIONS);
    const after = { messages: messages(handle.db), items: handle.db.all(sql`SELECT id FROM items ORDER BY id`) };

    runMigrations(handle.db, MIGRATIONS);

    expect({ messages: messages(handle.db), items: handle.db.all(sql`SELECT id FROM items ORDER BY id`) }).toEqual(after);
  });

  it("fires the occurrence a migrated skip offer names, when its owner answers Run it now", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);
    runMigrations(handle.db, MIGRATIONS);

    const answered = handleMessageHere(handle.db, { messageId: seeded.offer, how: "answered", answer: RUN_NOW_OPTION });

    expect(answered).toMatchObject({ ok: true, message: { handledHow: "answered" } });
    const occurrences = listOccurrences(handle.db, seeded.jobId as Uuid);
    expect(occurrences.find((occurrence) => occurrence.status === "fired")?.dueAt).toBe(seeded.occurrenceDueAt);
  });

  it("resolves a migrated conflict notice once its conflict is resolved", () => {
    const handle = beforeTheMigration();
    const seeded = seed(handle.db);
    runMigrations(handle.db, MIGRATIONS);

    resolveUpdateConflict(handle.db, seeded.conflictId, "published", 500);

    expect(messages(handle.db).filter((message) => message.source === "template_conflict").map((message) => message.handledHow)).toEqual(["resolved", "resolved"]);
  });

  it("writes the same messages on the organisation's record and on a desktop's replica of its threads, so the sync finds one", () => {
    const record = beforeTheMigration();
    const replica = beforeTheMigration();
    const onTheRecord = seed(record.db);
    // The replica holds the record's rows under the record's ids.
    seed(replica.db, onTheRecord);

    runMigrations(record.db, MIGRATIONS);
    runMigrations(replica.db, MIGRATIONS);

    // On the record its threads are converted and removed, as on a desktop.
    expect(getItem(record.db, onTheRecord.notesId)).toBeUndefined();
    expect(messages(record.db).map((message) => message.recipientId)).toEqual([ANNA, BEN, LOCAL_PERSON_ID]);
    // And each message is the very row the replica wrote for the same
    // mention, so the record's sync overwrites the copy rather than
    // adding a second.
    const withoutProject = (db: DbHandle["db"]) => messages(db).map(({ projectId: _projectId, ...rest }) => rest);
    expect(withoutProject(replica.db)).toEqual(withoutProject(record.db));
  });
});
