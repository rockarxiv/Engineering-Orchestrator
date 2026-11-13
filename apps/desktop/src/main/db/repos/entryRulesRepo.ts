import { entryRefusalSentence, qualifiedItemType, type CustomModule, type EntryDoor, type EntryRule, type Item, type Uuid } from "@eo/core";
import { entryCheckModuleProblem, entryRefusal, moduleEntryChecks, type ModuleEntryCheck } from "@eo/engine";
import type { Db } from "../client.js";
import { registry } from "../../registry.js";
import { getItemType, type ItemType } from "./itemTypesRepo.js";
import { getModule } from "./modulesRepo.js";
import { moduleAtVersion } from "./moduleVersionsRepo.js";
import { getPipeline } from "./pipelineStepsRepo.js";
import { entryRulesForArrival } from "./pipelineVersionsRepo.js";

/**
 * Whether work may enter a pipeline (EO-610, ARCHITECTURE.md, "Entry
 * rules"): the reads `packages/engine` cannot make for itself.
 */

/** What is arriving, and where. Facts rather than an item, because at creation and on a job's template there is no item yet. */
export interface Arrival {
  pipelineId: string;
  stepId: string | null;
  type: ItemType;
  body: string | null;
  spec: Readonly<Record<string, unknown>> | null;
  hasWorkspace: boolean;
  extensions: Readonly<Record<string, unknown>>;
}

/**
 * The sentence the data rules refuse this arrival with, or null where
 * they let it in. A `module` rule is not judged here (EO-736): see
 * `moduleRulesApply` and `modules/entryChecks.ts`.
 */
export function arrivalRefusal(db: Db, arrival: Arrival): string | null {
  const rules = entryRulesForArrival(db, arrival.pipelineId, arrival.stepId);
  if (rules.length === 0) return null;
  return entryRefusal(
    getPipeline(db, arrival.pipelineId)?.name ?? "This pipeline",
    rules,
    {
      itemType: qualifiedItemType(arrival.type),
      body: arrival.body,
      spec: arrival.spec,
      hasWorkspace: arrival.hasWorkspace,
      declaredFields: Object.keys(arrival.type.specShape.properties),
      extensions: arrival.extensions,
    },
    registry.entryRuleKinds,
  );
}

/** Whether an item of this type entering here has a `module` rule to pass (EO-736). */
export function moduleRulesApply(db: Db, pipelineId: string, stepId: string | null, type: ItemType): boolean {
  return moduleEntryChecks(entryRulesForArrival(db, pipelineId, stepId), qualifiedItemType(type)).length > 0;
}

// ── Module rules at a door (EO-736) ─────────────────────────────
//
// A module rule runs code, which takes a subprocess and time, and every
// door that judges entry rules is synchronous where it writes: the item
// is created, or moved, in one transaction, after the rules are judged
// and before anything is written. So the door is run twice or more
// rather than split in half. `withModuleEntryChecks`
// (`modules/entryChecks.ts`) runs the door's synchronous body with the
// verdicts it has so far. A module rule with no verdict yet is recorded
// here as pending and refuses — before the key is minted, before the row,
// before any write, as every entry refusal does — and the door runs the
// pending checks and tries again with their verdicts. A door that never
// asks gives no verdicts and is refused with a sentence that says so:
// fail closed.

/** One arrival a module rule has to judge, as a door met it. */
export interface PendingEntryCheck {
  /**
   * What this arrival is, and what it was to be judged under, so the same
   * arrival on the next try finds its verdict — and an arrival whose rules
   * or modules changed meanwhile does not.
   */
  fingerprint: string;
  door: EntryDoor;
  /**
   * The item as it would enter: on its destination pipeline and step. On
   * creation its id names no row and its key is empty.
   */
  item: Item;
  creating: boolean;
  /** The step it is leaving, on a move or a route; null on creation. */
  fromStepId: string | null;
  /** The module checks the door met, as they stood: the ones the verdict is for. */
  checks: ModuleEntryCheck[];
}

interface DoorVerdicts {
  door: EntryDoor;
  verdicts: ReadonlyMap<string, string | null>;
  pending: PendingEntryCheck[];
  /** The verdicts are all there will be: a check with none cannot run here, rather than pending. */
  final: boolean;
}

/** The verdicts of the door being run now, or null where none is. Synchronous code only reads it. */
let atDoor: DoorVerdicts | null = null;

/**
 * Runs a door's synchronous body with the module verdicts reached so far,
 * and answers what it returned with the module checks it met and had no
 * verdict for. Only `withModuleEntryChecks` should call this.
 */
export function runWithEntryVerdicts<T>(
  door: EntryDoor,
  verdicts: ReadonlyMap<string, string | null>,
  body: () => T,
  /** Worked out beforehand, and not to be asked for again: see `DoorVerdicts.final`. */
  options: { final?: boolean } = {},
): { result: T; pending: PendingEntryCheck[] } {
  const previous = atDoor;
  const here: DoorVerdicts = { door, verdicts, pending: [], final: options.final === true };
  atDoor = here;
  try {
    return { result: body(), pending: here.pending };
  } finally {
    atDoor = previous;
  }
}

/** Placeholder sentence for a check the door has yet to run; never shown, since the door runs it and tries again. */
const PENDING = "An entry check is still to run.";

function arrivalKeyOf(door: EntryDoor, item: Item, creating: boolean, fromStepId: string | null): string {
  // Not the times, and on creation not the id, the key or the parent: an
  // item being created is given a fresh id each time the door runs, has no
  // key, and under a plan has a container minted afresh in each run too.
  const facts: Record<string, unknown> = { ...item };
  delete facts["createdAt"];
  delete facts["updatedAt"];
  if (creating) {
    delete facts["id"];
    delete facts["key"];
    delete facts["parentId"];
  }
  return JSON.stringify({ door, creating, fromStepId, facts });
}

/**
 * What a verdict was reached under: the module checks, with the rules'
 * own words and limits, and each module's revision and approval. A verdict
 * is only ever read back under the same, so a rule published, a module
 * edited, archived or its approval withdrawn while a check was running
 * sends the door round again rather than letting the old answer stand.
 */
function basisOf(checks: readonly ModuleEntryCheck[], modules: readonly (CustomModule | undefined)[]): string {
  return JSON.stringify(
    checks.map((check, index) => {
      const module = modules[index];
      return {
        module: check.module,
        moduleVersion: check.moduleVersion,
        timeoutMs: check.timeoutMs,
        rules: check.rules.map((rule) => rule.message ?? null),
        revision: module === undefined ? null : [module.updatedAt, module.approvedAt, module.archivedAt],
      };
    }),
  );
}

/**
 * How a module's refusal reads among the things a pipeline needs: the
 * rule's own words where it has them, and always the module (EO-736).
 */
export function moduleRefusalWords(rule: EntryRule, module: CustomModule | undefined, id: string, why: string): string {
  const name = module?.name ?? (id === "" ? "an entry check that names no module" : id);
  const message = rule.message?.trim();
  if (message !== undefined && message !== "") return `${message} ("${name}" ${why})`;
  return `a pass from "${name}", which ${why}`;
}

/**
 * Why this module cannot judge anything now, as a clause about it, or null:
 * no module named, or one missing, deleted, unapproved or no longer an
 * entry check.
 */
export function unfitModuleClause(check: ModuleEntryCheck, module: CustomModule | undefined): string | null {
  if (check.module === "") return "cannot run: the rule names no module";
  if (module !== undefined && pinnedVersionGone.has(module)) return `cannot run: the v${check.moduleVersion ?? "?"} it pins is not kept any more`;
  const problem = entryCheckModuleProblem(module);
  if (problem === null && module !== undefined) return null;
  // The version the rule pins, by number (EO-770): it is what has to be
  // approved and declared an entry check, whatever the module's head is.
  const subject = module !== undefined && module.archivedAt === null && check.moduleVersion !== null ? `its v${check.moduleVersion}` : "it";
  return `cannot run: ${subject} ${problem ?? "is not a module this installation has"}`;
}

/** Modules `entryCheckModule` answered with whose pinned version is not kept, for `unfitModuleClause` to say so. */
const pinnedVersionGone = new WeakSet<CustomModule>();

/**
 * The module an entry check runs (EO-770): the version its rules pin —
 * its code, manifest and approval — or the module as it stands for rules
 * written before pins. Undefined for a module this installation does not
 * have; one whose pinned version is not kept is answered as it stands and
 * refused by `unfitModuleClause`, which says which version is gone.
 */
export function entryCheckModule(db: Db, check: ModuleEntryCheck): CustomModule | undefined {
  const catalogued = check.module === "" ? undefined : getModule(db, check.module);
  if (catalogued === undefined) return undefined;
  const pinned = moduleAtVersion(db, catalogued, check.moduleVersion);
  if (pinned.ok) return pinned.module;
  const gone = { ...catalogued };
  pinnedVersionGone.add(gone);
  return gone;
}

/**
 * What the module rules say of this arrival, as far as this door knows:
 * the verdict reached for it, a pending refusal the door will replace
 * with one, or — where no door is waiting on module checks — a refusal
 * naming the module and saying it cannot run here.
 *
 * Asked inside the door's own write, so whatever verdict it answers holds
 * for the rules and modules as they stand at that instant.
 */
function moduleVerdict(db: Db, item: Item, creating: boolean, fromStepId: string | null): string | null {
  if (item.pipelineId === null) return null;
  const type = getItemType(db, item.typeId);
  if (type === undefined) return null;
  const checks = moduleEntryChecks(entryRulesForArrival(db, item.pipelineId, item.stepId), qualifiedItemType(type));
  if (checks.length === 0) return null;
  const modules = checks.map((check) => entryCheckModule(db, check));
  const pipelineName = getPipeline(db, item.pipelineId)?.name ?? "This pipeline";
  const refusing = (index: number, why: string): string =>
    entryRefusalSentence(pipelineName, [moduleRefusalWords(checks[index]!.rules[0]!, modules[index], checks[index]!.module, why)]);
  // The modules as they are now, whatever any check found earlier: one
  // deleted, unapproved or edited out of being an entry check keeps the
  // item out, in the listed order.
  const unfit = (): string | null => {
    for (const [index, check] of checks.entries()) {
      const why = unfitModuleClause(check, modules[index]);
      if (why !== null) return refusing(index, why);
    }
    return null;
  };
  const cannotRunHere = (why: string): string => unfit() ?? refusing(0, why);
  if (atDoor === null) return cannotRunHere(NOWHERE_WAITS);
  const arrivalKey = arrivalKeyOf(atDoor.door, item, creating, fromStepId);
  const fingerprint = `${arrivalKey}\n${basisOf(checks, modules)}`;
  const verdict = atDoor.verdicts.get(fingerprint);
  if (verdict !== undefined) return verdict ?? unfit();
  if (atDoor.final) {
    const changed = [...atDoor.verdicts.keys()].some((key) => key.startsWith(`${arrivalKey}\n`));
    return cannotRunHere(changed ? CHANGED_WHILE_RUNNING : NOWHERE_WAITS);
  }
  if (!atDoor.pending.some((each) => each.fingerprint === fingerprint)) {
    atDoor.pending.push({ fingerprint, door: atDoor.door, item, creating, fromStepId, checks });
  }
  return PENDING;
}

const NOWHERE_WAITS = "cannot run where this item is arriving from: nothing here waits for a module";
const CHANGED_WHILE_RUNNING = "was asked under entry rules or a module that changed while it ran, so its answer no longer stands";

/**
 * Why the entry rules refuse an item about to be created, given as the
 * item it would be (EO-736) — the data rules first, and the module rules
 * only where those let it in.
 */
export function newItemEntryRefusal(db: Db, arrival: Arrival, item: Item): string | null {
  return arrivalRefusal(db, arrival) ?? moduleVerdict(db, item, true, null);
}

/**
 * The same for an item that exists and is moving in from elsewhere.
 *
 * Null where the pipeline is the one it is on: only entering is checked.
 * Null on a rehearsal too, so a trial or a preview does not exercise the
 * rules.
 *
 * `judgeModules` false judges the data rules alone, for a caller that
 * runs the module rules itself once these pass — a run handing work on,
 * whose route is decided in code that cannot wait (`handOffModuleRefusal`).
 */
export function itemEntryRefusal(db: Db, item: Item, toPipelineId: string | null, toStepId: string, judgeModules = true): string | null {
  if (toPipelineId === null || toPipelineId === item.pipelineId) return null;
  if (item.trialAt !== null || item.previewAt !== null) return null;
  const type = getItemType(db, item.typeId as Uuid);
  if (type === undefined) return null;
  const data = arrivalRefusal(db, {
    pipelineId: toPipelineId,
    stepId: toStepId,
    type,
    body: item.body,
    spec: item.spec,
    hasWorkspace: item.workspaceId !== null,
    extensions: item.extensions,
  });
  if (data !== null || !judgeModules) return data;
  return moduleVerdict(db, enteringItem(item, toPipelineId, toStepId), false, item.stepId);
}

/** An item as it would stand on arrival: on the destination, bound to no version yet. */
export function enteringItem(item: Item, toPipelineId: string, toStepId: string): Item {
  return { ...item, pipelineId: toPipelineId as Uuid, stepId: toStepId, pipelineVersionId: null };
}
