import { z } from "zod";
import { EntryRulesSchema, MODULE_ENTRY_RULE_KIND, entryRuleWords, type EntryRule, type EntryRuleKind } from "./entryRules.js";
import { describeDuration } from "./limits.js";
import { PipelineStepViewSchema, StepRouteViewSchema } from "./ipc-schemas.js";
import { StepWatchSchema, watchLine } from "./watch.js";

/**
 * A published shape of one pipeline (EO-327, the original design).
 *
 * "Versions are immutable step and route sets. An item binds to the
 * version it entered on and finishes there." Until this, `pipelines`
 * had no version column at all and a save rewrote the graph under
 * whatever was standing on it — so an item mid-flight routed by rules
 * nobody had agreed to when it started, and a step deleted from under
 * it had nothing to say about where it should go.
 *
 * A version is a *document*: the steps, the routes and where work
 * enters, exactly as they stood the moment somebody saved. The live
 * `pipeline_steps` and `step_routes` rows remain the current version —
 * which is what keeps every existing reader correct — and an older
 * version is read back out of here.
 *
 * `number` rather than the id is what a person sees: "v6" is a word on
 * a chip, and a uuid is not.
 */
export const PipelineVersionSchema = z.object({
  id: z.string(),
  pipelineId: z.string(),
  /** 1, 2, 3… within one pipeline. What "v6" means. */
  number: z.number().int().positive(),
  createdAt: z.number(),
  /**
   * The person who saved it, where there is one (the original design's "by Dana").
   *
   * Null for a version EO wrote itself — the one the migration filed
   * for a pipeline that predates versions, and the one lazily taken of
   * a graph an install wrote step by step. Nobody pressed Save for
   * those, and naming the local person would be inventing an author.
   */
  createdBy: z.string().nullable(),
  /** The name to show for `createdBy`, resolved where the version is read. Null when unknown. */
  createdByName: z.string().nullable(),
  /** The release notes of the template update that filed it (EO-728), one version per line; null for every other version. */
  releaseNotes: z.string().nullable(),
});
export type PipelineVersion = z.infer<typeof PipelineVersionSchema>;

/**
 * How many versions of each pipeline an installation keeps (EO-359).
 *
 * A whole number of one or more. One is the floor because the version a
 * pipeline is on is never deleted, so "keep none" is a setting EO could
 * not honour — and a schema that let it be written would be a setting
 * that silently means something else.
 *
 * The limit is applied at each pipeline's next save, oldest first, and
 * never to a version anything still stands on: the current one, any an
 * item is bound to (archived included), and the newest number the
 * pipeline has used, which is what keeps a number from being handed out
 * twice.
 */
export const PipelineVersionsToKeepSchema = z.number().int().min(1);

/** Twenty: a few weeks of edits on a busy pipeline, and a list short enough to read. */
export const DEFAULT_PIPELINE_VERSIONS_TO_KEEP = 20;

/**
 * How a version number is written wherever it is short (a card's chip,
 * a ghost column's head).
 *
 * One function rather than three template literals, for the reason
 * `stepHoldsItemsMessage` gives: a person meeting `v6`, `V6` and
 * `version 6` on one screen is reading three things.
 */
export function versionLabel(number: number): string {
  return `v${number}`;
}

const MODULE_UPDATE_AUTHOR_PREFIX = "module:";

/**
 * The author a pipeline version is filed under when approving a module
 * version moved the pipeline's pin to it (EO-771): `module:<slug>@<number>`.
 * Read back by `moduleUpdateOfAuthor`, as `templateUpdateAuthor` is by
 * `templateUpdateOfAuthor`.
 */
export function moduleUpdateAuthor(slug: string, number: number): string {
  return `${MODULE_UPDATE_AUTHOR_PREFIX}${slug}@${number}`;
}

/**
 * The module update a version's `createdBy` names, or null for a version
 * a person, EO or a template update filed. `version` is null where the
 * author names no number this build can read.
 */
export function moduleUpdateOfAuthor(createdBy: string | null): { slug: string; version: number | null } | null {
  if (createdBy === null || !createdBy.startsWith(MODULE_UPDATE_AUTHOR_PREFIX)) return null;
  const named = createdBy.slice(MODULE_UPDATE_AUTHOR_PREFIX.length);
  const at = named.lastIndexOf("@");
  if (at <= 0) return { slug: named, version: null };
  const number = Number(named.slice(at + 1));
  return { slug: named.slice(0, at), version: Number.isInteger(number) && number > 0 ? number : null };
}

/**
 * The banner above a board whose pipeline has moved on (the original design).
 *
 * "Pipeline updated to v7 by Dana · 3 items finish on v6". Three facts
 * and one sentence: what the current version is, who published it, and
 * how much work is still finishing on the old one — which is the only
 * part a person can act on, and the reason the banner exists rather
 * than a toast that disappears.
 *
 * The author is dropped rather than replaced with "somebody" when the
 * version has none: a version EO took of a graph nobody saved has no
 * author to name, and inventing one is worse than a shorter sentence.
 * The finishing clause is dropped when nothing is finishing, which is
 * what makes this a description of the board rather than a notice.
 */
export function pipelineUpdatedBanner(input: { current: number; older: { number: number; items: number }[]; by: string | null }): string {
  const lead = `Pipeline updated to ${versionLabel(input.current)}${input.by === null ? "" : ` by ${input.by}`}`;
  const finishing = input.older
    .filter((older) => older.items > 0)
    .sort((a, b) => b.number - a.number)
    .map((older) => `${older.items} ${older.items === 1 ? "item finishes" : "items finish"} on ${versionLabel(older.number)}`);
  return [lead, ...finishing].join(" · ");
}

/**
 * The head of a ghost column (the original design).
 *
 * "Review (v6) · 2 finishing". A step that exists only in an older
 * version and still holds work is not a column of the pipeline any
 * more, and it is not nothing either — the items on it are still
 * running, and a board that stopped drawing them would be a board
 * showing fewer items than the project has.
 */
export function ghostColumnLabel(input: { stepName: string; number: number; holding: number }): string {
  return `${input.stepName} (${versionLabel(input.number)}) · ${input.holding} finishing`;
}

/**
 * Why an item may not be moved onto that step (EO-327, the original design).
 *
 * "An item binds to the version it entered on and finishes there" cuts
 * both ways: the graph cannot be changed under the item, and the item
 * cannot be walked out of the graph it agreed to. A step added after it
 * entered has no definition in its version and no route leaving it — so
 * an item put there would run whatever the current graph says and then
 * have nowhere to go, which is the strand this whole story exists to
 * prevent, arrived at from the other direction.
 *
 * Refused rather than repaired, for `transitionItem`'s reason about a
 * step and a pipeline that disagree: re-binding the item to the current
 * version would be EO deciding that a drag meant "and start this over
 * under the new rules", which is a decision nobody made. The sentence
 * says what is possible instead, because a refusal that names no way
 * forward is a dead end.
 *
 * One wording, in `@eo/core`, for the three doors that meet it: the
 * drag, the bulk move offered beside a strand refusal, and the MCP
 * tool that does the same thing for an agent.
 */
export function stepNotInVersionMessage(input: { stepName: string; number: number }): string {
  return (
    `"${input.stepName}" is not part of ${versionLabel(input.number)}, and this item finishes on ${versionLabel(input.number)}. ` +
    `Move it to a step ${versionLabel(input.number)} has — the board draws those, including any it is the last to hold — or leave it where it is.`
  );
}

/**
 * The document a version holds — the graph, frozen (EO-327).
 *
 * The same step shape `RecordPipelineSchema` sends over the wire, and
 * for the same reason it extends the view schema there: a step is
 * carried whole or the thing that reads it later is not the thing that
 * ran. `offBoard`, `ownerPersonId` and `ownerGroupId` are not on the
 * view schema because a screen draws the board, and all three matter to
 * an item finishing on an older version.
 *
 * Defaulted throughout, so a snapshot written by an older build still
 * parses into a graph this one can route by. A snapshot that will not
 * parse at all is a version that cannot be honoured, and the caller
 * falls back to the live graph rather than stranding the item.
 */
export const PipelineGraphSnapshotSchema = z.object({
  steps: z.array(
    PipelineStepViewSchema.extend({
      offBoard: z.boolean().default(false),
      ownerPersonId: z.string().nullable().default(null),
      ownerGroupId: z.string().nullable().default(null),
    }),
  ),
  routes: z.array(StepRouteViewSchema),
  entryStepId: z.string().nullable().default(null),
  /** What an item had to have to enter (EO-610). Part of what a version says, so a rollback restores it. */
  entryRules: EntryRulesSchema.default([]),
});
export type PipelineGraphSnapshot = z.infer<typeof PipelineGraphSnapshotSchema>;

/**
 * A step of a version, as a diff reads it. The live shape, minus what
 * is a fact about this machine.
 *
 * `workspaceId`, `inputs` and `timeoutMs` are the three the saved
 * document holds and this does not, and each for the same reason: a
 * workspace id means nothing on another machine, a module's configured
 * values and its time limit are local tuning, and none of the three is
 * part of what the graph *says*. Everything that is — including the
 * order the steps are in and the decisions a person may take at one —
 * is here, because a version is an immutable step set and a diff that
 * carried less than the set does would report no change to a version
 * that is genuinely different.
 */
export const VersionStepSchema = z.object({
  id: z.string(),
  position: z.number(),
  name: z.string(),
  type: z.string(),
  ownerRole: z.string().nullable(),
  entryAction: z.string().nullable(),
  /** The prose under the step — what the design calls the prompt, and what a diff of a version is mostly about. */
  instructionsSummary: z.string().nullable(),
  isTerminal: z.boolean(),
  planMode: z.boolean(),
  offBoard: z.boolean(),
  /**
   * What a person may decide here (EO-310) — the buttons a human step
   * offers, which a save can rename, retone, reorder or take away.
   *
   * Carried because it is *executable*: an item finishing on an older
   * version is offered this version's buttons and `items:decide` judges
   * its answer against them, so a diff silent about a changed result
   * key would be silent about the difference between two versions that
   * accept different answers.
   */
  results: z.array(z.object({ key: z.string(), label: z.string(), tone: z.string(), requiresComment: z.boolean() })),
  /**
   * Keep checking (EO-456): how often the step checks and when it gives
   * up. Carried for `results`' reason — it is executable, a step that
   * watches and one that runs once do different things to the same item
   * — and defaulted so a version written before it existed parses as a
   * step that runs once.
   */
  watch: StepWatchSchema.nullable().default(null),
  /**
   * The version of its module a module step runs (EO-770). Carried for
   * `results`' reason: it is the code the step runs, so two versions
   * pinning different module versions are different pipelines. Defaulted
   * so a document written before pins parses as pinning nothing.
   */
  moduleVersion: z.number().int().positive().nullable().default(null),
});
export type VersionStep = z.infer<typeof VersionStepSchema>;

/**
 * A route of a version, as a diff reads it.
 *
 * Every field the saved document holds about a route except its id,
 * which is regenerated on every save (`replacePipelineGraph`) and so is
 * not a fact about the route at all. That completeness is the point: a
 * version is an immutable route *set*, and a save that changes only a
 * label produces a different set — so a diff carrying less than the set
 * does would answer "nothing changed" about a save that changed
 * something. `label` and `tone` are what a person reads on the button
 * and the dot beside it, and `position` is the order the results are
 * offered in, which is a decision somebody made.
 */
export const VersionRouteSchema = z.object({
  fromStepId: z.string(),
  resultKey: z.string(),
  label: z.string(),
  target: z.string(),
  tone: z.string(),
  position: z.number(),
});
export type VersionRoute = z.infer<typeof VersionRouteSchema>;

/**
 * What changed between two versions, as the read-only diff draws it
 * (ARCHITECTURE.md, "Publish, lock and versions", and "Divergence and suggestions" reuses it for a
 * suggestion).
 *
 * Steps, routes and prompts, which is what the design names. Computed here
 * rather than in the renderer because the server's screen is the same
 * renderer in an admin role, and a diff that lived in one of them would
 * be a diff the other could not show.
 */
export const VersionDiffSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  steps: z.array(
    z.object({
      stepId: z.string(),
      name: z.string(),
      change: z.enum(["added", "removed", "changed"]),
      /**
       * What kind of step it is (EO-681), for the chip the diff draws
       * beside its name: read from the version the step belongs to — the
       * newer one for a step added or changed, the older one for a step
       * removed. Null for a terminal step, which is an end and not a kind
       * of work, and for a diff from a record older than the field.
       */
      kind: z
        .object({ type: PipelineStepViewSchema.shape.type, ownerRole: z.string().nullable(), entryAction: z.string().nullable() })
        .nullable()
        .default(null),
      /** Field-level, so "the prompt changed" and "it was renamed" are not the same line. */
      fields: z.array(z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    }),
  ),
  routes: z.array(
    z.object({
      fromStepName: z.string(),
      resultKey: z.string(),
      change: z.enum(["added", "removed", "changed"]),
      /**
       * Field-level, exactly as a step's changes are, and for a sharper
       * reason: a route has four fields a save can change and only one
       * of them is where it goes. Reporting a route as a pair of
       * targets said "nothing changed" about renaming a button, which
       * is the commonest route edit there is.
       *
       * A route that was added or removed lists its fields too, with
       * the missing side null — "added" on its own does not say where
       * the new branch goes, and that is the first thing anybody asks.
       */
      fields: z.array(z.object({ field: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
    }),
  ),
  /**
   * The entry rules on each side (EO-610), each a line, or null where
   * they are the same. Two lines rather than a list of changes: rules
   * have no ids to pair them by, and they are short. Defaulted, so a diff
   * from an older record reads as no change.
   */
  entryRules: z.object({ before: z.string(), after: z.string() }).nullable().default(null),
});
export type VersionDiff = z.infer<typeof VersionDiffSchema>;

/**
 * The fields of a step a diff reports on, in the order it lists them.
 *
 * Every field `VersionStep` carries but its id, which is what finds the
 * step on both sides rather than something about it. `position` is in
 * here because reordering the columns is a save somebody made
 * deliberately, and `results` because the buttons a human step offers
 * are what a person on an older version is actually given.
 */
const DIFFED_FIELDS = ["name", "type", "ownerRole", "entryAction", "instructionsSummary", "isTerminal", "planMode", "offBoard", "position", "results", "watch"] as const;

/**
 * And of a route, in the order it lists them.
 *
 * Every field `VersionRoute` carries but the two that identify it —
 * a route is found by the step it leaves and the result it is for, so
 * those are the head of the entry rather than a change within it.
 * `target` leads because where a branch goes is the first question; the
 * other three are what the branch is called, how it is drawn, and where
 * in the list it is offered.
 */
const DIFFED_ROUTE_FIELDS = ["target", "label", "tone", "position"] as const;

function shown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * The decisions a step offers, as one line.
 *
 * A list rather than a scalar, so it cannot go through `shown` — which
 * would print `[object Object]` and call two entirely different sets of
 * buttons equal. Written the way the step editor reads them: the key a
 * route names, the words on the button, how it is drawn, and whether
 * taking it demands a reason.
 *
 * "none" rather than an empty string for a step that offers nothing, so
 * a diff reads "none → Approve" rather than " → Approve".
 */
function shownResults(results: VersionStep["results"]): string {
  if (results.length === 0) return "none";
  return results.map((result) => `${result.key} "${result.label}" (${result.tone}${result.requiresComment ? ", reason required" : ""})`).join(", ");
}

/** Entry rules as one line. "none" for `shownResults`' reason, and each rule's types, since a change to them changes nothing else it says. */
export function shownEntryRules(rules: readonly EntryRule[], moduleNames?: ReadonlyMap<string, string>): string {
  if (rules.length === 0) return "none";
  return rules.map((rule) => shownEntryRule(rule, moduleNames)).join(", ");
}

/**
 * One entry rule as a line: its words, and its types. A module rule names
 * its module and any time limit it sets (EO-736), since changing either
 * changes what the door does. What the diff lists and what a pipeline's
 * details list, so the two read the same.
 */
export function shownEntryRule(
  rule: EntryRule,
  moduleNames?: ReadonlyMap<string, string>,
  /** The kinds packs contribute, so a pack's rule reads in its own words. Absent, by its kind. */
  kinds?: ReadonlyMap<string, EntryRuleKind>,
): string {
  // The version a module rule pins (EO-770), since moving it changes the code the door runs.
  const pinned = rule.kind === MODULE_ENTRY_RULE_KIND && rule.moduleVersion !== undefined ? ` ${versionLabel(rule.moduleVersion)}` : "";
  const words =
    rule.kind === MODULE_ENTRY_RULE_KIND && rule.message !== undefined
      ? `${rule.message} (a pass from "${moduleNames?.get(rule.module ?? "") ?? rule.module ?? "a module"}"${pinned})`
      : `${entryRuleWords(rule, kinds, moduleNames)}${pinned}`;
  const limit = rule.kind === MODULE_ENTRY_RULE_KIND && rule.timeoutMs !== undefined ? `, within ${describeDuration(rule.timeoutMs)}` : "";
  return `${words}${limit}${rule.types === undefined ? "" : ` (${rule.types.join(", ")})`}`;
}

/**
 * A changed module pin as the diff lists it (EO-770): "Notify v3 → v4",
 * the module named on the side it was before, and again on the other
 * side only where the step now runs another module. Null where the pin
 * did not change, or where one side pins nothing — a document from before
 * pins, which says nothing about versions rather than "no version".
 */
function moduleVersionChange(was: VersionStep, step: VersionStep, moduleNames: ReadonlyMap<string, string> | undefined): { field: string; before: string | null; after: string | null } | null {
  if (was.moduleVersion === null || step.moduleVersion === null) return null;
  if (was.entryAction === step.entryAction && was.moduleVersion === step.moduleVersion) return null;
  const name = (id: string | null) => moduleNames?.get(id ?? "") ?? id ?? "module";
  const before = `${name(was.entryAction)} ${versionLabel(was.moduleVersion)}`;
  const after = was.entryAction === step.entryAction ? versionLabel(step.moduleVersion) : `${name(step.entryAction)} ${versionLabel(step.moduleVersion)}`;
  return { field: "module", before, after };
}

/** One field of a step, as the diff prints it. */
function shownStepField(field: (typeof DIFFED_FIELDS)[number], step: VersionStep): string | null {
  if (field === "results") return shownResults(step.results);
  // "runs once" rather than nothing, so turning the mode off reads as a
  // change to something rather than the field disappearing.
  if (field === "watch") return watchLine(step) ?? "runs once";
  return shown(step[field]);
}

/**
 * The difference between two version documents.
 *
 * Pure, and in `@eo/core` rather than `@eo/engine`, because both the
 * renderer and the main process read it and neither owns it. A step
 * present in both is compared field by field and omitted when nothing
 * about it moved — a diff listing every unchanged step is a diff
 * nobody reads.
 */
/** A step's kind as a diff row carries it: null for a terminal step, and for a type this build does not know. */
function stepKind(step: VersionStep): VersionDiff["steps"][number]["kind"] {
  if (step.isTerminal) return null;
  const type = PipelineStepViewSchema.shape.type.safeParse(step.type);
  return type.success ? { type: type.data, ownerRole: step.ownerRole, entryAction: step.entryAction } : null;
}

export function diffVersions(
  from: { number: number; steps: VersionStep[]; routes: VersionRoute[]; entryRules?: readonly EntryRule[] },
  to: { number: number; steps: VersionStep[]; routes: VersionRoute[]; entryRules?: readonly EntryRule[] },
  /** Module names by id, so a module rule is listed by name (EO-736). Absent, by id. */
  moduleNames?: ReadonlyMap<string, string>,
): VersionDiff {
  const before = new Map(from.steps.map((step) => [step.id, step] as const));
  const after = new Map(to.steps.map((step) => [step.id, step] as const));
  const names = new Map([...from.steps, ...to.steps].map((step) => [step.id, step.name] as const));

  const steps: VersionDiff["steps"] = [];
  for (const [id, step] of after) {
    const was = before.get(id);
    if (!was) {
      steps.push({ stepId: id, name: step.name, change: "added", kind: stepKind(step), fields: [] });
      continue;
    }
    const fields: VersionDiff["steps"][number]["fields"] = DIFFED_FIELDS.flatMap((field) =>
      shownStepField(field, was) === shownStepField(field, step)
        ? []
        : [{ field, before: shownStepField(field, was), after: shownStepField(field, step) }],
    );
    const pin = moduleVersionChange(was, step, moduleNames);
    if (pin !== null) fields.push(pin);
    if (fields.length > 0) steps.push({ stepId: id, name: step.name, change: "changed", kind: stepKind(step), fields });
  }
  for (const [id, step] of before) {
    if (!after.has(id)) steps.push({ stepId: id, name: step.name, change: "removed", kind: stepKind(step), fields: [] });
  }

  // A route is identified by the step it leaves and the result it is
  // for — `step_routes` has a unique index on exactly that pair. The
  // separator is written as an escape rather than typed: a literal NUL
  // in source is invisible to the next reader, and a character that can
  // appear in neither half is what keeps two routes from sharing a key.
  const routeKey = (route: VersionRoute) => `${route.fromStepId}\u0000${route.resultKey}`;
  const beforeRoutes = new Map(from.routes.map((route) => [routeKey(route), route] as const));
  const afterRoutes = new Map(to.routes.map((route) => [routeKey(route), route] as const));
  // A target is a step id, and a step id is a uuid: shown as the step's
  // name wherever the graph has one. The two sentinels (`terminal`,
  // `user_attention`) name no step and read as themselves, which is what
  // the fallback gives.
  const shownFor = (field: (typeof DIFFED_ROUTE_FIELDS)[number], route: VersionRoute): string | null =>
    field === "target" ? (names.get(route.target) ?? route.target) : shown(route[field]);

  const routes: VersionDiff["routes"] = [];
  for (const [key, route] of afterRoutes) {
    const was = beforeRoutes.get(key);
    const head = { fromStepName: names.get(route.fromStepId) ?? route.fromStepId, resultKey: route.resultKey };
    if (!was) {
      routes.push({ ...head, change: "added", fields: DIFFED_ROUTE_FIELDS.map((field) => ({ field, before: null, after: shownFor(field, route) })) });
      continue;
    }
    const fields = DIFFED_ROUTE_FIELDS.flatMap((field) =>
      shownFor(field, was) === shownFor(field, route) ? [] : [{ field, before: shownFor(field, was), after: shownFor(field, route) }],
    );
    if (fields.length > 0) routes.push({ ...head, change: "changed", fields });
  }
  for (const [key, route] of beforeRoutes) {
    if (afterRoutes.has(key)) continue;
    routes.push({
      fromStepName: names.get(route.fromStepId) ?? route.fromStepId,
      resultKey: route.resultKey,
      change: "removed",
      fields: DIFFED_ROUTE_FIELDS.map((field) => ({ field, before: shownFor(field, route), after: null })),
    });
  }

  const rulesBefore = from.entryRules ?? [];
  const rulesAfter = to.entryRules ?? [];
  const entryRules = JSON.stringify(rulesBefore) === JSON.stringify(rulesAfter) ? null : { before: shownEntryRules(rulesBefore, moduleNames), after: shownEntryRules(rulesAfter, moduleNames) };

  return { from: from.number, to: to.number, steps, routes, entryRules };
}
