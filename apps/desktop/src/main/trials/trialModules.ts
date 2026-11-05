import { createHash } from "node:crypto";
import type { Db } from "../db/client.js";
import { getModule, moduleForkedFrom, moduleInLiveUse } from "../db/repos/index.js";

/**
 * Which module a trial runs for a module its draft names (EO-583,
 * EO-587), decided in one place so that what a design card shows and what
 * approving it grants are the same module.
 *
 *   * `carried` — a draft copy an earlier trial of the same conversation
 *     made of it, still in the catalogue and still nobody's live work: the
 *     copy the loop has been fixing, reused as it stands;
 *   * `fork` — a new draft copy, of `contentsOf`: the named module where a
 *     published pipeline uses it, or a carried copy that live work has
 *     since come to use, so the fixes in it are kept while the copy itself
 *     is left to the live work that adopted it;
 *   * `itself` — the module, where nothing live runs it.
 *
 * Nothing is written here; `grantModules` makes the fork.
 */
export type TrialModuleChoice = { kind: "itself"; moduleId: string } | { kind: "carried"; moduleId: string } | { kind: "fork"; contentsOf: string };

export function trialModuleFor(db: Db, moduleId: string, carried: Readonly<Record<string, string>>): TrialModuleChoice {
  const copyId = carried[moduleId];
  const copy = copyId === undefined ? undefined : getModule(db, copyId);
  if (copy !== undefined && copy.archivedAt === null && moduleForkedFrom(db, copy.id) === moduleId) {
    // A copy is in the ordinary catalogue: once live work runs it, a trial
    // editing it would be editing live work.
    return moduleInLiveUse(db, copy.id) ? { kind: "fork", contentsOf: copy.id } : { kind: "carried", moduleId: copy.id };
  }
  return moduleInLiveUse(db, moduleId) ? { kind: "fork", contentsOf: moduleId } : { kind: "itself", moduleId };
}

/** The module whose code, needs and cases a trial would run for this choice: the one it runs, or the one its fork copies. */
export function moduleShownFor(choice: TrialModuleChoice): string {
  return choice.kind === "fork" ? choice.contentsOf : choice.moduleId;
}

/**
 * A digest of a module's code as it is saved now (EO-588), or the empty
 * string for a module that is gone: what a trial's design keeps of each
 * module it was approved with, so the publish card can say whose code
 * moved since — without keeping a second copy of the code.
 */
export function moduleCodeDigest(db: Db, moduleId: string): string {
  const module = getModule(db, moduleId);
  return module === undefined ? "" : createHash("sha256").update(module.code).digest("hex");
}
