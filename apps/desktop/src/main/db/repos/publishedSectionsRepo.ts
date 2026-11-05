import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { SectionDocumentSchema, type PublishedSection, type PublishedSectionView, type RecordCursor, type SectionDocument } from "@eo/core";
import type { Db } from "../client.js";
import { publishedSections } from "../schema.js";

/**
 * The rows behind a lock (EO-329, `ARCHITECTURE.md`,
 * "Publish, lock and versions").
 *
 * Writing one is publishing; the reads are what every locked screen,
 * the command guard and the sync all ask. Nothing here decides whether
 * a section is *locked* — that is a fact about the installation as well
 * as about the row, and it is answered in `managed/locks.ts` where the
 * installation is known.
 */

function toView(row: typeof publishedSections.$inferSelect): PublishedSectionView {
  return {
    section: row.section as PublishedSection,
    subjectId: row.subjectId,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    publishedByName: row.publishedByName,
    // Parsed rather than cast: the column is JSON this process wrote or
    // a *different version* of it wrote, and a document one build cannot
    // read is better read as "nothing published with it" than trusted
    // into a writer that will throw halfway through applying it.
    document: documentOf(row.document),
  };
}

function documentOf(raw: unknown): SectionDocument | null {
  if (raw === null || raw === undefined) return null;
  const parsed = SectionDocumentSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** What a publish records, from either end: the record writing one or a replica storing it. */
export interface PublishSectionInput {
  section: PublishedSection;
  /** The pipeline this version belongs to. `""` for a section with no versions. */
  subjectId?: string;
  versionId?: string | null;
  versionNumber?: number | null;
  publishedAt: number;
  publishedBy?: string | null;
  publishedByName?: string | null;
  /** What the section held when it was published. Null for a pipelines row — see the migration. */
  document?: SectionDocument | null;
}

/**
 * Publishes a section, or publishes it again.
 *
 * Idempotent on `(section, subjectId)`: publishing twice is one row with
 * a later stamp, and a rollback is that same write pointing at an older
 * version. There is no history table beside it, and deliberately — what
 * a person can go back to is the *pipeline's* versions, which are
 * already immutable rows with numbers on them (EO-327). A second
 * history of publishes would be a second answer to "what can I roll back
 * to", able to disagree with the first.
 */
export function publishSection(db: Db, input: PublishSectionInput): PublishedSectionView {
  const row = {
    section: input.section,
    subjectId: input.subjectId ?? "",
    versionId: input.versionId ?? null,
    versionNumber: input.versionNumber ?? null,
    publishedAt: input.publishedAt,
    publishedBy: input.publishedBy ?? null,
    publishedByName: input.publishedByName ?? null,
    document: input.document ?? null,
  };
  return toView(
    db
      .insert(publishedSections)
      .values(row)
      .onConflictDoUpdate({
        target: [publishedSections.section, publishedSections.subjectId],
        set: {
          versionId: row.versionId,
          versionNumber: row.versionNumber,
          publishedAt: row.publishedAt,
          publishedBy: row.publishedBy,
          publishedByName: row.publishedByName,
          document: row.document,
        },
      })
      .returning()
      .get(),
  );
}

/**
 * Everything published here, newest first — what `sections:list`
 * answers with.
 *
 * Newest first because a rollback re-publishes: the same row gets a
 * later stamp and possibly a different person's name on it, and every
 * screen that reads this shows the *first* row of a section as "what
 * was published". Oldest-first would have the lock crediting whoever
 * published in March for a rollback somebody else made this morning.
 */
export function listPublishedSections(db: Db): PublishedSectionView[] {
  return db.select().from(publishedSections).orderBy(desc(publishedSections.publishedAt), publishedSections.section).all().map(toView);
}

/**
 * Whether this section has been published at all, and by whom.
 *
 * The question the guard asks, and it asks it of the *section* — any
 * row under it, whatever its subject. Per section, never per field
 * (ARCHITECTURE.md, "Publish, lock and versions"): one published pipeline is a published pipelines
 * section.
 *
 * The most recent row of the section, for `listPublishedSections`'
 * reason: the name in the refusal is the name on the screen, and both
 * should be whoever published last.
 */
export function publishedSectionRow(db: Db, section: PublishedSection): PublishedSectionView | undefined {
  const row = db
    .select()
    .from(publishedSections)
    .where(eq(publishedSections.section, section))
    .orderBy(desc(publishedSections.publishedAt))
    .get();
  return row ? toView(row) : undefined;
}

/** What this pipeline was published at, if it was. */
export function publishedPipelineRow(db: Db, pipelineId: string): PublishedSectionView | undefined {
  const row = db
    .select()
    .from(publishedSections)
    .where(and(eq(publishedSections.section, "pipelines"), eq(publishedSections.subjectId, pipelineId)))
    .get();
  return row ? toView(row) : undefined;
}

/**
 * The rows a device has not seen, by the keyset every other list uses.
 *
 * `(publishedAt, key)` where the key is `section:subjectId`, which is
 * the primary key written out — several rows share a millisecond
 * routinely, because publishing the pipelines section writes one per
 * pipeline in a single statement.
 */
export function listPublishedSectionsSince(db: Db, cursor: RecordCursor, limit: number): (PublishedSectionView & { key: string })[] {
  const key = sql<string>`${publishedSections.section} || ':' || ${publishedSections.subjectId}`;
  return db
    .select()
    .from(publishedSections)
    .where(or(gt(publishedSections.publishedAt, cursor.ts), and(eq(publishedSections.publishedAt, cursor.ts), gt(key, cursor.id))))
    .orderBy(asc(publishedSections.publishedAt), asc(key))
    .limit(limit)
    .all()
    .map((row) => ({ ...toView(row), key: `${row.section}:${row.subjectId}` }));
}

/**
 * Forgets every published section this installation holds.
 *
 * Signing out of an organisation, and nothing else. A desktop that is
 * no longer anybody's device is a solo desktop again, and a lock left
 * behind by a record it can no longer reach would be a configuration
 * nobody on earth could unlock — the admin cannot, because this machine
 * never asks them anything again.
 */
export function forgetPublishedSections(db: Db): void {
  db.delete(publishedSections).run();
}
