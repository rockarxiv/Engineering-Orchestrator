import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Item, Message } from "@eo/core";
import { asc, eq } from "drizzle-orm";
import { openDb, type Db, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createItem, type CreateItemInput } from "./repos/itemsRepo.js";
import { getMessage } from "./repos/messagesRepo.js";
import { messages, pipelines } from "./schema.js";
import { createDefaultProject } from "./repos/projectsRepo.js";
import { createGitWorkspace, getGitWorkspace, type GitWorkspace } from "./repos/workspacesRepo.js";
import { settleDailyBudgetNotice } from "../guardDefaultNotice.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** An in-memory DB with the real migrations (schema + seed) already applied. */
export function openMigratedTestDb(): DbHandle {
  return openMigratedTestDbAt(":memory:");
}

/**
 * A database created here is a database being *born*, which is what
 * `index.ts` decides with `isNewDatabase` a line before it migrates
 * (EO-211). Saying so here is what keeps a test fixture in a state a
 * real installation is ever in: without it every test database looks
 * like one upgraded from a version that had no daily budget, and the
 * first tick of half the suite would post a notice about it.
 *
 * A test that wants the upgrade — a database that predates the default —
 * clears this, which is the honest way round: the unusual state is the
 * one set up explicitly.
 */
function bornUnderTodaysDefaults(db: Db): void {
  settleDailyBudgetNotice(db);
}

/**
 * The same, but as a file on disk.
 *
 * For the one kind of test that has to look at the bytes: EO-104 asserts
 * that a secret set through the keychain-backed store cannot be found by
 * reading the database, and `:memory:` has no database to read.
 */
export function openMigratedTestDbAt(dbPath: string): DbHandle {
  const handle = openDb(dbPath);
  runMigrations(handle.db, migrationsFolder);
  bornUnderTodaysDefaults(handle.db);
  return handle;
}

/**
 * What a fixture story declares, so that it can reach review (EO-213).
 *
 * The scheduler refuses to dispatch a review of an item that declares
 * no acceptance criteria, so a test that drives a story past the
 * implementer has to give it at least one. Shared rather than written
 * out at each fixture because *what* it says is beside the point in
 * every one of them and *that* it is there is the whole point: a story
 * quietly created without it fails as "the review never ran", which is a
 * long way from the line that caused it.
 */
export const REVIEWABLE_SPEC = {
  acceptance_criteria: ["The limiter returns 429 after 100 requests in a minute."],
};

/**
 * The item a fixture wanted, or a thrown failure (KAN-129).
 *
 * `createItem` answers with a typed result now, because a type is a row
 * a project may not have and asking for one it lacks is a refusal
 * rather than a crash. A fixture is the one caller for which that is
 * never a question: it writes `"story"` itself against a database the
 * migrations just seeded, and every one of the five hundred call sites
 * unwrapping the result by hand would bury what each test is actually
 * about.
 *
 * So the unwrapping is here, once, and it is loud: a refusal means the
 * fixture asked for a type this database has no row for, which is a
 * broken test rather than a case to handle. Named for what it is, so
 * that a test meaning to *exercise* the refusal reaches for the
 * repository's own `createItem` and gets the result back.
 */
export function createTestItem(db: Db, input: CreateItemInput): Item {
  const created = createItem(db, input);
  if (!created.ok) throw new Error(`createTestItem: ${created.problem}`);
  return created.item;
}

/**
 * A repository attached the way the app attaches one — which since
 * KAN-130 is a `git-worktree` workspace.
 *
 * `createWorkspace` writes the workspace and nothing else; every door
 * into EO — the Settings screen, `repository_create`, onboarding — then
 * puts it on a project (KAN-17). Since KAN-128 that project is also
 * where the key prefix lives, so a workspace created without one
 * has no prefix to number its items from and they fall through to the
 * `EO` default. A fixture in that state is a fixture no installation is
 * ever in, and the keys it produces are not the keys the app produces.
 *
 * So: both rows, one call, the prefix named where a test can see it. A
 * test that genuinely wants a workspace no project holds — the state a
 * deleted project leaves behind — calls `createWorkspace` directly and
 * means it.
 *
 * The input is flat rather than `{ config: { ... } }`, because a fixture
 * saying `repoPath` reads better than one spelling out which kind's
 * config it is filling in.
 *
 * The first project made this way is given the seeded Delivery, as first
 * run from its template gives it (EO-766): a fixture of a configured
 * installation is one whose project has a pipeline.
 */
export function attachWorkspace(
  db: Db,
  input: { keyPrefix: string; name: string; repoPath: string; description?: string | null; baseBranch?: string; testCommand?: string | null; lintCommand?: string | null; buildCommand?: string | null },
): GitWorkspace {
  const { keyPrefix, ...config } = input;
  const workspace = createGitWorkspace(db, { config });
  const project = createDefaultProject(db, workspace, keyPrefix);
  // The first project of a fixture works on the seeded Delivery, as the
  // first project of an installation set up from its template does
  // (EO-766). A later one has no pipeline until a test gives it one.
  const seeded = db.select({ projectId: pipelines.projectId, archivedAt: pipelines.archivedAt }).from(pipelines).where(eq(pipelines.id, "default")).get();
  if (seeded !== undefined && seeded.projectId === null && seeded.archivedAt === null) giveSeededDelivery(db, project.id);
  // Read back: the project is what attaches it, so the row the caller is
  // handed must be the attached one rather than the detached row the
  // insert returned a moment earlier.
  return getGitWorkspace(db, workspace.id) ?? workspace;
}

/** Every message a source sent, open or handled, oldest first (EO-727). */
export function messagesFrom(db: Db, source: string): Message[] {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.source, source))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all()
    .flatMap((row) => getMessage(db, row.id) ?? []);
}

/** Every message about one job, open or handled, oldest first (EO-729): what its guards said. */
export function messagesAboutJob(db: Db, jobId: string): Message[] {
  const rows = db.select({ id: messages.id }).from(messages).where(eq(messages.jobId, jobId)).orderBy(asc(messages.createdAt), asc(messages.id)).all();
  return rows.flatMap((row) => {
    const message = getMessage(db, row.id);
    return message ? [message] : [];
  });
}

/**
 * The seeded Delivery given to a project, as first run does when the first
 * project is made from the template it is an export of (EO-317, EO-766).
 *
 * No pipeline is shown to a project that is not its own any more, so a
 * fixture whose project works on Delivery says so with this rather than
 * relying on Delivery being shared.
 */
export function giveSeededDelivery(db: Db, projectId: string): void {
  db.update(pipelines).set({ projectId, updatedAt: Date.now() }).where(eq(pipelines.id, "default")).run();
}
