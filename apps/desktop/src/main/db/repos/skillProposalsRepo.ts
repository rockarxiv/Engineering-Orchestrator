import { and, desc, eq } from "drizzle-orm";
import { uuidv7, type MemoryScope, type MemoryScopeKind, type SkillProposalStatus, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { skillProposals } from "../schema.js";

/**
 * Skills a memory consolidation proposed (EO-483, ARCHITECTURE.md,
 * "What an agent is given").
 *
 * The one module that writes `skill_proposals`. Since EO-719 a row is
 * written for each proposal a consolidation applied, `saved` from the
 * start, in the same transaction as the skill write, the retired entries
 * and the notice it records (`memory/skillProposals.ts`). Rows written
 * before then may still be `open` — waiting on a Save nobody can press
 * any more — or `discarded`: a person's Discard, which still holds its
 * scope and slug back. Nothing here saves a skill or retires an entry.
 */

type Row = typeof skillProposals.$inferSelect;

export interface SkillProposalRecord {
  id: string;
  consolidationId: string;
  scope: MemoryScope;
  kind: "new" | "improvement";
  targetSlug: string | null;
  targetSkillId: string | null;
  slug: string;
  name: string;
  description: string;
  body: string;
  evidenceEntryIds: string[];
  evidenceItemIds: string[];
  coveringEntryIds: string[];
  fingerprint: string;
  status: SkillProposalStatus;
  unsaveable: string | null;
  commentId: string | null;
  skillId: string | null;
  movedEntryIds: string[];
  createdAt: number;
  decidedAt: number | null;
}

function toRecord(row: Row): SkillProposalRecord {
  return {
    id: row.id,
    consolidationId: row.consolidationId,
    scope: { kind: row.scopeKind as MemoryScopeKind, id: row.scopeId },
    kind: row.kind === "improvement" ? "improvement" : "new",
    targetSlug: row.targetSlug,
    targetSkillId: row.targetSkillId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    evidenceEntryIds: row.evidenceEntryIds,
    evidenceItemIds: row.evidenceItemIds,
    coveringEntryIds: row.coveringEntryIds,
    fingerprint: row.fingerprint,
    status: row.status as SkillProposalStatus,
    unsaveable: row.unsaveable,
    commentId: row.commentId,
    skillId: row.skillId,
    movedEntryIds: row.movedEntryIds,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

export type RecordSkillProposalInput = Omit<SkillProposalRecord, "id" | "status" | "skillId" | "movedEntryIds" | "decidedAt"> & { id?: Uuid };

/** A proposal as it was posted: open, undecided. */
export function recordSkillProposal(db: Db, input: RecordSkillProposalInput): SkillProposalRecord {
  const row: Row = {
    id: input.id ?? (uuidv7() as Uuid),
    consolidationId: input.consolidationId,
    scopeKind: input.scope.kind,
    scopeId: input.scope.id,
    kind: input.kind,
    targetSlug: input.targetSlug,
    targetSkillId: input.targetSkillId,
    slug: input.slug,
    name: input.name,
    description: input.description,
    body: input.body,
    evidenceEntryIds: input.evidenceEntryIds,
    evidenceItemIds: input.evidenceItemIds,
    coveringEntryIds: input.coveringEntryIds,
    fingerprint: input.fingerprint,
    status: "open",
    unsaveable: input.unsaveable,
    commentId: input.commentId,
    skillId: null,
    movedEntryIds: [],
    createdAt: input.createdAt,
    decidedAt: null,
  };
  db.insert(skillProposals).values(row).run();
  return toRecord(row);
}

export function getSkillProposal(db: Db, id: string): SkillProposalRecord | undefined {
  const row = db.select().from(skillProposals).where(eq(skillProposals.id, id)).get();
  return row ? toRecord(row) : undefined;
}

/** A consolidation's proposals, in the order they were posted. */
export function listSkillProposalsOf(db: Db, consolidationId: string): SkillProposalRecord[] {
  return db
    .select()
    .from(skillProposals)
    .where(eq(skillProposals.consolidationId, consolidationId))
    .orderBy(skillProposals.createdAt, skillProposals.id)
    .all()
    .map(toRecord);
}

/**
 * Whether a person discarded a proposal with this scope and slug, with
 * the Discard answer proposals offered before EO-719 (EO-512). Matched by
 * slug alone, not by the fingerprint: the model rewords a description
 * freely, and what the person turned down was the skill, not its
 * wording. Nothing removes such a record now that "Propose again" is
 * gone, so it holds for good.
 */
export function skillProposalDiscarded(db: Db, scope: MemoryScope, slug: string): boolean {
  return (
    db
      .select({ id: skillProposals.id })
      .from(skillProposals)
      .where(and(eq(skillProposals.scopeKind, scope.kind), eq(skillProposals.scopeId, scope.id), eq(skillProposals.status, "discarded"), eq(skillProposals.slug, slug)))
      .get() !== undefined
  );
}

/** A proposal a person discarded, as a consolidation is told of it. */
export interface DiscardedSkillProposal {
  slug: string;
  description: string;
}

/**
 * The proposals a person discarded in a scope, one per slug with the
 * description it was last discarded with, newest first (EO-512): what a
 * consolidation is told not to propose again.
 */
export function listDiscardedSkillProposals(db: Db, scope: MemoryScope): DiscardedSkillProposal[] {
  const rows = db
    .select({ slug: skillProposals.slug, description: skillProposals.description })
    .from(skillProposals)
    .where(and(eq(skillProposals.scopeKind, scope.kind), eq(skillProposals.scopeId, scope.id), eq(skillProposals.status, "discarded")))
    .orderBy(desc(skillProposals.decidedAt), desc(skillProposals.id))
    .all();
  const bySlug = new Map<string, DiscardedSkillProposal>();
  for (const row of rows) if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  return [...bySlug.values()];
}

/** Records what became of a proposal: `saved` once a consolidation applied it. Only an open proposal is decided; answers whether this call decided it. */
export function decideSkillProposal(
  db: Db,
  id: string,
  decision: { status: Exclude<SkillProposalStatus, "open">; skillId?: string | null; movedEntryIds?: string[]; now: number },
): boolean {
  return (
    db
      .update(skillProposals)
      .set({
        status: decision.status,
        decidedAt: decision.now,
        skillId: decision.skillId ?? null,
        movedEntryIds: decision.movedEntryIds ?? [],
      })
      .where(and(eq(skillProposals.id, id), eq(skillProposals.status, "open")))
      .run().changes === 1
  );
}
