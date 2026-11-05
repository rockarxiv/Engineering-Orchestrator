import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { uuidv7, type MemoryScope, type MemoryScopeKind, type SkillProposalStatus, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { memoryConsolidations, skillProposals } from "../schema.js";

/**
 * Skills a memory consolidation proposed (EO-483, ARCHITECTURE.md,
 * "What an agent is given").
 *
 * The one module that writes `skill_proposals`. A row is written when a
 * proposal is posted, and decided once — saved or discarded — when a
 * person answers the comment. A discarded row is removed only when a
 * person asks for the proposal to be allowed again (EO-512). Nothing here saves a skill or retires an
 * entry; that is `memory/skillProposals.ts`, which calls `decide` in the
 * same transaction as the work it records.
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

/** The proposal a comment was posted for, if it was posted for one. */
export function skillProposalForComment(db: Db, commentId: string): SkillProposalRecord | undefined {
  const row = db.select().from(skillProposals).where(eq(skillProposals.commentId, commentId)).get();
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
 * Why a proposal is not posted again, or null.
 *
 * - `discarded` — a person discarded one with the same scope and slug
 *   (EO-512). Matched by slug alone, not by the fingerprint: the model
 *   rewords a description freely, and what the person turned down was
 *   the skill, not its wording. It holds until a person removes the
 *   discard record (`forgetDiscardedSkillProposals`).
 * - `open` — one with the same fingerprint is still on the thread
 *   waiting for an answer. One whose comment was deleted, or whose
 *   consolidation was restored, is not waiting for anything, so it does
 *   not hold a new one back.
 */
export function knownSkillProposal(db: Db, scope: MemoryScope, proposal: { slug: string; fingerprint: string }): "discarded" | "open" | null {
  const rows = db
    .select({ status: skillProposals.status, consolidationStatus: memoryConsolidations.status })
    .from(skillProposals)
    .leftJoin(memoryConsolidations, eq(memoryConsolidations.id, skillProposals.consolidationId))
    .where(
      and(
        eq(skillProposals.scopeKind, scope.kind),
        eq(skillProposals.scopeId, scope.id),
        or(
          and(eq(skillProposals.status, "discarded"), eq(skillProposals.slug, proposal.slug)),
          and(eq(skillProposals.status, "open"), eq(skillProposals.fingerprint, proposal.fingerprint), isNotNull(skillProposals.commentId)),
        ),
      ),
    )
    .all();
  if (rows.some((row) => row.status === "discarded")) return "discarded";
  // One whose consolidation was restored can no longer be saved (see
  // `answerSkillProposal`), so it is not waiting for anything either.
  return rows.some((row) => row.consolidationStatus !== "restored") ? "open" : null;
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

/**
 * Removes the discard records for a slug in a scope (EO-512) — every
 * one, since any of them alone would still hold the slug back — so a
 * later consolidation may propose it again. Answers how many it removed.
 *
 * A person's act and only theirs: `answerSkillProposal` calls it on a
 * "Propose again" reply under a discarded proposal.
 */
export function forgetDiscardedSkillProposals(db: Db, scope: MemoryScope, slug: string): number {
  return db
    .delete(skillProposals)
    .where(
      and(eq(skillProposals.scopeKind, scope.kind), eq(skillProposals.scopeId, scope.id), eq(skillProposals.slug, slug), eq(skillProposals.status, "discarded")),
    )
    .run().changes;
}

/** Records a person's answer. Only an open proposal is decided; answers whether this call decided it. */
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
