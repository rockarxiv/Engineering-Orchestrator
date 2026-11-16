import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { moduleChangeProposals } from "../schema.js";

/**
 * Module-change proposals frozen by an assistant or scenario turn (EO-813,
 * migration 0175).
 *
 * **Append-only.** There is deliberately no update and no delete here: a
 * card a person may still apply reads the row, and what it shows must be
 * what it applies. `db/architecturalInvariants.test.ts` holds the tree to
 * it. A row goes only with its conversation, run or module, by cascade.
 */

export type ModuleChangeProposalRow = typeof moduleChangeProposals.$inferSelect;
export type InsertModuleChangeProposal = typeof moduleChangeProposals.$inferInsert;

/** Keeps one proposal. The only write this table has. */
export function insertModuleChangeProposal(db: Db, row: InsertModuleChangeProposal): void {
  db.insert(moduleChangeProposals).values(row).run();
}

/** One proposal by id, whoever it belongs to — the caller decides whether the asker may have it. */
export function getModuleChangeProposal(db: Db, id: string): ModuleChangeProposalRow | undefined {
  return db.select().from(moduleChangeProposals).where(eq(moduleChangeProposals.id, id)).get();
}
