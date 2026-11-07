import { z } from "zod";
import { isThreadPerConversationAction, type Agent, type ModuleInput } from "../domain.js";
import type { EntryRuleKind } from "../entryRules.js";
import type { ActionDefinition } from "../schemas/actionDefinition.js";
import type { OutputSchema } from "../schemas/outputSchema.js";
import { SpecShapeSchema, type SpecShape } from "../schemas/specShape.js";
import { WAITING_RESULT } from "../watch.js";

/**
 * The registry: what roles, built-in functions and item types this
 * installation knows about, as data (KAN-124, ARCHITECTURE.md, "Where the seams are").
 *
 * Until this existed the answers were four closed constants in this
 * package — the built-in roles, the built-in actions and their results,
 * the schema map by action — and a discriminated union in the intake
 * schema. Each was code: a second pack could not add a role, a builtin
 * or a type without editing `packages/core`, which is the one place a
 * pack must never have to reach. The validator had already stopped
 * reading the module catalog for itself and taken it as an input
 * (KAN-104, `ValidatePipelineInput.modules`); this gives roles, builtins
 * and item types the same treatment.
 *
 * A value rather than a registration API. `SCHEMAS_BY_ACTION` was a
 * module-level map, and the trouble with a module-level map is not that
 * nothing can add to it — a `register()` would fix that in a line — but
 * that its contents are then a property of *import order*, which is a
 * property of nothing anybody can read. A value is built once, in the
 * composition root, from whatever packs are installed, and every lookup
 * is handed the same one (KAN-144 is the fold that builds it; until then
 * the desktop holds `developerRegistry()`).
 *
 * Plain data. Nothing here touches a database or a filesystem. A role's
 * schemas are `OutputSchema` values (KAN-125, landed before this): the
 * same shapes `SCHEMAS_BY_ACTION` held, behind the wrapper that zod and
 * a JSON Schema document both satisfy, so a pack shipping its schemas as
 * data contributes an entry of exactly this type rather than a second
 * kind of one.
 *
 * `ReadonlyMap` throughout rather than a record, because the keys are
 * slugs somebody chose — a role called `constructor` or `__proto__` is
 * a legitimate thing to type into the Agents editor and a record would
 * quietly answer wrong for it.
 */

/**
 * What decides thread reuse for a role, when `true` and `false` are not
 * the whole story (EO-210).
 *
 * A third answer rather than a second table: the system agent's answer
 * is neither unknown nor conditional on configuration, it is conditional
 * on *what it was dispatched to do*, and saying so in the entry is what
 * stops a reader taking a bare boolean for the whole story.
 */
export const PER_CONVERSATION = "per-conversation";

export type ThreadReuse = boolean | typeof PER_CONVERSATION;

/**
 * What the registry says about a role, short of its schemas.
 *
 * Split from `RoleEntry` because these two are what crosses IPC and
 * what every lookup but `resultSchemaFor` reads. The renderer marks a
 * role built-in and draws or omits the thread-reuse checkbox from this
 * much; the schemas are the main process's, and a renderer that held
 * copies of them would be validating results nobody asked it to.
 */
export interface RoleFacts {
  /**
   * Where the role's default prompt is: the file's name in the pack's
   * prompt directory (`implementer.md`).
   *
   * A name rather than the text, because the text is versioned in a
   * file precisely so it can be diffed and blamed (R-01), and because
   * this package cannot read files. What reads it, and from which
   * directory, is the pack's business — `loadRolePrompt` today.
   */
  prompt: string;
  /**
   * Whether an agent in this role keeps one provider thread per item
   * (EO-86, EO-178, EO-210). See `reusesThreadPerItem`, which is the
   * one reader and says what each answer costs.
   */
  threadReuse: ThreadReuse;
  /**
   * The actions the pack ships for this role, by action name, each with
   * the results it can return (EO-423).
   *
   * On the facts rather than beside the schemas, because this is the half
   * of an action a screen and the validator need and the renderer may
   * hold: which keys a step dispatching it has to route. The schema that
   * holds the answer to those keys stays in the main process.
   *
   * Optional, and absent on a role that ships no action a step
   * dispatches. Looked up by action across every role, as the schemas
   * are — see `actionFactsFor`.
   */
  actions?: ReadonlyMap<string, ActionFacts>;
}

/** One result an action can return: the key a route matches, and what a person reads for it. */
export interface ActionResultFacts {
  key: string;
  label: string;
  /**
   * When to return it (EO-425) — the sentence the agent is given beside
   * the key. Absent on a pack's action, whose prompt says it instead.
   */
  meaning?: string | undefined;
}

/**
 * What an action is, short of its schema (EO-423): what it is for, the
 * results it can return, and whose it is.
 *
 * The same shape for an action a pack ships and one a role defined for
 * itself, because the readers — `validatePipeline`, the agent screen, the
 * pipeline editor — ask the same thing of both. `packShipped` is the one
 * difference that matters to them: a pack's action is read-only.
 */
export interface ActionFacts {
  description: string;
  results: readonly ActionResultFacts[];
  /** Whether a pack ships it, rather than a role on this installation having defined it. */
  packShipped: boolean;
  /**
   * The extra answer properties a role's definition declares, as the
   * JSON Schema it was saved with (EO-425). Absent on a pack's action:
   * its shape is the pack's schema, which stays in the main process.
   */
  fields?: Readonly<Record<string, unknown>> | undefined;
}

/** By role slug, then by action. Maps for the reason the registry is maps throughout. */
export type RoleActionFacts = ReadonlyMap<string, ReadonlyMap<string, ActionFacts>>;

export interface RoleEntry extends RoleFacts {
  /**
   * The shape each of this role's actions must answer in, by action.
   *
   * On the role because that is who declares it — a pack shipping a
   * reviewer ships the verdict shape with it — but *looked up by
   * action*, across every role (`resultSchemaFor`), because roles are
   * configuration (ARCHITECTURE.md, "An agent is a row"): a step may dispatch a role
   * nobody shipped on an action somebody did, and that run is held to
   * the action's shape exactly as a shipped role's would be. Two roles
   * declaring one action differently is a collision `buildRegistry`
   * refuses rather than a question import order gets to answer.
   *
   * `OutputSchema` rather than a zod type (KAN-125), so that the pack
   * contributing the entry decides whether it ships zod or a JSON Schema
   * document, and nothing reading the registry has to know which.
   */
  schemasByAction: ReadonlyMap<string, OutputSchema>;
  /**
   * What this role's actions mean on a type that overrides none of them
   * (KAN-163).
   *
   * The *pack defaults* The design asks for, and the second
   * half of the lookup `resultSchemaFor` makes: the type's own override
   * first, then this. A person creating a type in the configure screen
   * (ARCHITECTURE.md, "An item type is data") writes no overrides — the editor does not offer them
   * — so
   * without a default a hand-made leaf would be asked for a
   * decomposition, which is the branch this story exists to delete.
   *
   * On the role for `schemasByAction`'s reason: the pack that ships the
   * action ships what it means, and the lookup is by action across every
   * role rather than by whose it is. Off `RoleFacts` for the same reason
   * the schemas are — the renderer draws a checkbox, it does not decide
   * what a run answers in.
   *
   * Absent on almost every role. An action whose meaning does not vary
   * by type — `implement`, `review` — has one shape and one result key,
   * and saying so twice here would be two places to change it.
   */
  actionDefaults?: ReadonlyMap<string, ActionDefaults>;
}

/**
 * What an action means on a type that says nothing about it, by whether
 * the type holds others (KAN-163).
 *
 * Two answers rather than one, because the fact being defaulted is
 * itself two: `refine` on a container decomposes it and on a leaf
 * clarifies what is already written. A pack that ships an action meaning
 * the same thing on both kinds writes the same override twice, which is
 * honest — the alternative is a third state meaning "either", which
 * every reader would then have to resolve for itself.
 */
export interface ActionDefaults {
  /** For a type whose items hold other items. */
  container: ActionOverride;
  /** For a type whose items are the work. What a hand-made type inherits. */
  leaf: ActionOverride;
}

/**
 * One per-(type, action) fact, as data (ARCHITECTURE.md, "An item type is data").
 *
 * Five places in the code encode a single sentence: *refine on a
 * container decomposes it, and on a leaf clarifies what is already
 * written*. The schema the result is validated against, the route key
 * the run reports and the comment the thread ends up with all switch on
 * it. That is one fact wearing five disguises, and it belongs to the
 * type rather than to the role — the design lets a person create a type
 * without touching a role, and a hand-made leaf inherits the leaf
 * defaults.
 *
 * Written from KAN-129 and read since KAN-163, which is what replaced
 * those five branches with these three fields.
 */
export interface ActionOverride {
  /**
   * Whose schema this action's result is held to, named by action.
   *
   * The registry already resolves schemas by action
   * (`RoleEntry.schemasByAction`), so a name here is a name it can
   * answer — `refine` for the decomposition shape, `clarify` for the
   * other one. `clarify` is registered as a schema for exactly this
   * reason: reachable only through a hard-coded `if` in
   * `resultSchemaFor`, it was a shape no data could name.
   */
  schema: string;
  /** The route key a successful run reports — `decomposed`, `clarified`. */
  resultKey: string;
  /**
   * Which of the pack's comment posters writes the record of it.
   *
   * A name rather than a function, because this crosses into the
   * database: the pack keeps the table from name to poster, the way
   * `builtins` keeps one from action to runner.
   */
  poster: string;
}

/**
 * An item type (ARCHITECTURE.md, "An item type is data"): who ships it, labels, a container flag,
 * a spec shape and its action overrides.
 *
 * Populated for the three developer types as data. The container flag is
 * read since KAN-146 — it is what the fourteen sites that used to compare
 * a type against the word `feature` ask. The spec shape is what the
 * intake and decomposition schemas are composed from instead of
 * hard-coding story and bug (KAN-147), and the overrides are refine's two
 * shapes, read by the five sites that used to spell them out (KAN-163).
 *
 * **Keyed by `packSlug:slug`, not by slug.** A type is namespaced by the
 * pack that shipped it (ARCHITECTURE.md, "An item type is data"), and two packs may both ship a
 * `case` —
 * the picker is what disambiguates them for a person, showing "Case
 * (Support)". A registry keyed by the bare word would have to refuse
 * the second pack, which is the opposite of what a pack boundary is
 * for.
 */
export interface ItemTypeEntry {
  /** The pack that shipped it. `item_types.pack_slug` is this. */
  packSlug: string;
  /** Its own word: `story`. Unique within a pack and a project, not across packs. */
  slug: string;
  /** What the person reads, singular: "Story". */
  label: string;
  /** And plural: "Stories". */
  plural: string;
  /**
   * Whether this type holds others rather than work: a feature is a
   * container and stories are work, and the lifecycle derives a
   * container's state from its children in both directions.
   */
  container: boolean;
  /**
   * The structured fields the item carries, and which it must arrive
   * with — a story must carry acceptance criteria, a bug its four repro
   * fields.
   *
   * A JSON Schema for the item's `spec` object since KAN-147, which is
   * what creation validates against and what the intake schema is
   * composed from. See `schemas/specShape.ts`.
   */
  specShape: SpecShape;
  /** By action name. Empty for a type with nothing to override. */
  actionOverrides: Readonly<Record<string, ActionOverride>>;
}

/**
 * The words a pack puts on what it ships (ARCHITECTURE.md, "What a pack labels").
 *
 * A pack labels four things and no more: its item types, its steps, its
 * results, and the results the engine produces on its own. The first
 * three are already labels on rows — `item_types.label`, a step's
 * `name`, a route's `label` — and this is the fourth, plus the one word
 * those rows cannot carry: what the pack calls *an item of its own*,
 * for the cross-pipeline chrome that has to call it something.
 *
 * Why the chrome needs it at all, when the original design's rule is that the core
 * says "item": because a project with one pack has no ambiguity to
 * resolve. "Tickets" in the sidebar of an installation that has only
 * ever had the developer pack is not a developer word leaking into
 * neutral chrome, it is the only word there is — and neutralising it
 * would change every screen for every existing user to fix a problem
 * none of them has. `chromeVocabulary` is where that is decided; this
 * is only the data it decides from.
 */
export interface PackVocabulary {
  /** What one of this pack's items is called: "Ticket". */
  item: string;
  /** And several: "Tickets". */
  items: string;
  /**
   * What this pack calls the results the engine produces rather than a
   * runner — `needs_user_input` and `escalation` — by result key.
   *
   * On the pack rather than on a route row, because these two are the
   * engine's own and exist before any pipeline declares a route for
   * them: a support pack calling an escalation "Hand to a supervisor"
   * has to be able to say so once, not once per pipeline that routes
   * it. A route that *does* declare one still wins, since its `label`
   * is a word somebody typed about that particular edge.
   *
   * Empty for a pack with nothing to say about either, which leaves the
   * engine's own spelling in place.
   */
  results: Readonly<Record<string, string>>;
}

/** Which type, where two packs may have shipped the same word. */
export interface ItemTypeRef {
  packSlug: string;
  slug: string;
}

/**
 * `developer:story` — how a type is named where a bare slug would be
 * ambiguous.
 *
 * The key of `Registry.itemTypes`, and what `item_types`' unique index
 * spells as a pair of columns. One spelling, here, so that the registry
 * and the table cannot drift into two.
 */
export function qualifiedItemType(ref: ItemTypeRef): string {
  return `${ref.packSlug}:${ref.slug}`;
}

/**
 * And back — `developer:story` into the pair `resolveItemType` takes
 * unambiguously (KAN-164).
 *
 * A picker offering the project's types has to send *which* type, not
 * which word: two packs may ship a `case` (ARCHITECTURE.md, "An item type is data"), and a bare
 * slug is a
 * question with two answers that `resolveItemType` rightly refuses. So
 * the wire carries the qualified spelling and this is what reads it.
 *
 * Split at the first colon, because the pack is the namespace and a slug
 * cannot contain one — an unsplittable string is somebody's bare word
 * and gets `null` rather than a guessed pack.
 */
export function parseQualifiedItemType(qualified: string): ItemTypeRef | null {
  const at = qualified.indexOf(":");
  if (at <= 0 || at === qualified.length - 1) return null;
  return { packSlug: qualified.slice(0, at), slug: qualified.slice(at + 1) };
}

/**
 * Every type in this registry that goes by one word.
 *
 * More than one when two packs both ship it, which is the case a bare
 * slug cannot answer — the callers that take a word from outside use
 * this and refuse an ambiguous one rather than picking a winner.
 */
export function itemTypesNamed(registry: RegistryFacts, slug: string): ItemTypeEntry[] {
  return [...registry.itemTypes.values()].filter((type) => type.slug === slug);
}

/**
 * The registry's shape, over whatever a role entry is.
 *
 * Generic so that the wire form and the in-process form are one type
 * rather than two that agree today: `Registry` holds role entries with
 * their schemas, `RegistryFacts` holds the same registry short of them,
 * and a `Registry` *is* a `RegistryFacts` — every lookup that does not
 * need a schema is typed on the smaller one and takes either.
 */
/**
 * What a pack declares about one of the functions its `builtin` steps
 * can run.
 *
 * `results` are here for the reason a module's `manifest.results` is
 * data (EO-77): the runner produces one, the editor offers a row per
 * outcome, and `validatePipeline` checks a route key against them. At
 * least one each, and every one includes `FAILED_RESULT` —
 * `buildRegistry` refuses an entry that does not, since a function
 * whose failure has no name is a failure nothing can route.
 */
export interface BuiltinEntry {
  /**
   * What the editor calls it, in the person's words (EO-507): "Wait
   * until a date and time", not `wait_until`.
   *
   * Here rather than in the renderer, because a list of labels kept
   * there is a list of builtins kept there — and it was: the function
   * picker offered four names it had been told about, and the core's
   * `wait_until` was not one of them, so a step running it could only
   * be made by import. The picker reads this registry, so a function a
   * pack adds is one it offers.
   */
  label: string;
  results: readonly string[];
  /**
   * The values a step running this function can set, by input name
   * (EO-507, ARCHITECTURE.md, "A step": "inputs for a module or
   * builtin").
   *
   * A module's manifest has declared its inputs since KAN-103; this is
   * the same declaration for a function EO ships, and the editor draws
   * the same rows for it. What it decides is what exists: a value for a
   * name the function does not declare is one its runner never reads,
   * so the editor neither renders it nor keeps it when the step moves
   * to a different function. Optional, and absent is none.
   */
  inputs?: Readonly<Record<string, BuiltinInput>>;
  /**
   * Whether running this reaches outside EO (EO-334, ARCHITECTURE.md, "A connector is an MCP server
   * with a setup flow").
   *
   * The same flag a module's manifest and a connector's setup carry,
   * and read by one thing: the validator's refusal to publish a
   * pipeline that a webhook enters and a side effect ends, with nobody
   * asked in between. A payload arriving from the internet is not
   * something EO can filter, so what it is held to is *where it can
   * get to* — and that question can only be answered by whoever wrote
   * the function, which is the pack.
   *
   * Answered rather than defaulted, which is why it is not optional: a
   * pack that ships a `send` function and says nothing would have it
   * read as harmless, and the one place this is read is the one place
   * that matters. Cutting a worktree and building an index are the two
   * EO ships that answer no — both write to a disk of EO's own, which
   * nobody outside this machine can see. Opening a pull request is the
   * one that answers yes.
   */
  sideEffects: boolean;
  /**
   * Whether a step may run this function in keep-checking mode (EO-456,
   * ARCHITECTURE.md, "A step").
   *
   * A check is asked the same question on an interval and answers
   * `waiting` until it has a result, which is a different contract from
   * running once — so the pack says the function was written for it, and
   * `validatePipeline` refuses the mode on a step whose function does
   * not. Optional, and absent is no: every function EO shipped before
   * this runs once.
   */
  watch?: boolean;
  /**
   * Whether running this opens a pull request on the repository's forge,
   * through its command-line client — `gh` or `glab` (EO-663).
   *
   * The pack's word for it, so the needs check can say a pipeline needs
   * that client installed and signed in by reading the pipeline's own
   * steps rather than recognising a template (invariant 13). Optional,
   * and absent is no.
   */
  opensPullRequest?: boolean;
}

/**
 * One value a builtin step can set (EO-507) — `ModuleInput`'s shape, so
 * the one editor draws both, with the description required: a box named
 * `at` says nothing about what goes in it, and the pack is the only one
 * that knows.
 */
export interface BuiltinInput {
  type: ModuleInput["type"];
  description: string;
  /** What the runner does when the step sets nothing. Absent when it has no default. */
  // `| undefined` for `ModuleInput`'s reason: the wire form is parsed by zod.
  default?: string | number | boolean | undefined;
}

export interface RegistryOf<R extends RoleFacts> {
  /** By role slug — the `agents.role` column, and a step's `ownerRole`. */
  roles: ReadonlyMap<string, R>;
  /**
   * The functions a `builtin` step can run, by action name, each with
   * what it declares about itself.
   *
   * @see BuiltinEntry
   */
  builtins: ReadonlyMap<string, BuiltinEntry>;
  /**
   * By `packSlug:slug` — `qualifiedItemType`, which is what the
   * `item_types` row's identity is minus the project it is scoped to.
   */
  itemTypes: ReadonlyMap<string, ItemTypeEntry>;
  /**
   * What each installed pack calls its own work, by pack slug (EO-309).
   *
   * Keyed by the same slug `ItemTypeEntry.packSlug` carries, so the
   * types a project has and the words for them are one lookup apart.
   * A pack with no entry here has no vocabulary of its own, which is
   * the ordinary case for types somebody made by hand (`local`).
   */
  packs: ReadonlyMap<string, PackVocabulary>;
  /**
   * The actions roles on this installation define for themselves, short
   * of their schemas (EO-423).
   *
   * `Registry.actionDefinitions` with the schemas left behind, which is
   * what lets the renderer hold it: the validator runs on both sides of
   * IPC and has to be told the same thing on each. Not under `roles`,
   * because that map is the roles a pack *ships* (`isBuiltinRole`) and
   * the roles that define actions are mostly ones somebody made.
   *
   * Optional for `actionDefinitions`' reason: a registry built from
   * packs alone has none.
   */
  roleActions?: RoleActionFacts;
  /**
   * The entry rule kinds packs contribute, by kind (EO-610, ARCHITECTURE.md,
   * "Entry rules").
   *
   * Beside the three every installation answers, which are the core's
   * (`CORE_ENTRY_RULE_KINDS`). Optional for `roleActions`' reason: a
   * registry from no pack has none, and that is what lets the core build
   * without knowing what a Jira key is (invariant 13).
   */
  entryRuleKinds?: ReadonlyMap<string, EntryRuleKind>;
}

/**
 * An action a role defined for itself, with the schema generated from it
 * (EO-421).
 *
 * Both halves, because the two readers want different ones: validation
 * and the provider want the schema, and the prompt and the route want
 * the definition's own words and keys. Compiled once, where the registry
 * is put together, rather than on each lookup.
 */
export interface DefinedAction {
  definition: ActionDefinition;
  schema: OutputSchema;
}

/** By role slug, then by action — the pair a definition is keyed by. Maps for the reason the registry is maps throughout. */
export type ActionDefinitions = ReadonlyMap<string, ReadonlyMap<string, DefinedAction>>;

/**
 * The registry as the main process holds it, schemas included.
 *
 * `actionDefinitions` is the one member no pack contributes: a
 * definition is something a person wrote about a role on this
 * installation, held in a table, and the registry is where it meets the
 * lookups that already answer what an action's result is held to.
 * Optional so that a registry built from packs alone — the fold, a
 * test's — is one with no definitions rather than one that has to say
 * so.
 */
export type Registry = RegistryOf<RoleEntry> & { actionDefinitions?: ActionDefinitions };

/** The registry short of its schemas — what the renderer holds after `registry:get`. */
export type RegistryFacts = RegistryOf<RoleFacts>;

// ── Lookups ─────────────────────────────────────────────────────

/** Whether this is a role a pack ships, rather than one somebody invented. */
export function isBuiltinRole(registry: RegistryFacts, role: string): boolean {
  return registry.roles.has(role);
}

/** Whether this names a function a `builtin` step can run. */
export function isBuiltinAction(registry: RegistryFacts, action: string | null): boolean {
  return action !== null && registry.builtins.has(action);
}

/**
 * What a step running `action` can return, or null when nothing declares it.
 *
 * Null is not "returns nothing": it is "not a builtin". What an agent
 * step's action can return is a different declaration with a role in the
 * question — see `actionFactsFor` (EO-423).
 */
export function builtinResults(registry: RegistryFacts, action: string | null): readonly string[] | null {
  return action === null ? null : (registry.builtins.get(action)?.results ?? null);
}

/**
 * What the editor calls this function, or null when nothing declares it (EO-507).
 */
export function builtinLabel(registry: RegistryFacts, action: string | null): string | null {
  return action === null ? null : (registry.builtins.get(action)?.label ?? null);
}

/**
 * The inputs a step running `action` can set, or null when nothing
 * declares the function (EO-507).
 *
 * Null is "not a builtin", for `builtinResults`' reason. A function that
 * declares no inputs answers an empty record: there is nothing for a step
 * running it to set.
 */
export function builtinInputs(registry: RegistryFacts, action: string | null): Readonly<Record<string, BuiltinInput>> | null {
  if (action === null) return null;
  const entry = registry.builtins.get(action);
  return entry === undefined ? null : (entry.inputs ?? {});
}

/**
 * Whether running this function reaches outside EO (EO-334).
 *
 * False for an action nothing declares, which is the same answer as
 * "declares nothing about it": a step running a function this
 * installation does not have is refused by `validatePipeline` for that
 * reason, and guessing that an unknown name might send something would
 * add a second refusal about a step that already has one.
 */
export function builtinHasSideEffects(registry: RegistryFacts, action: string | null): boolean {
  return action !== null && registry.builtins.get(action)?.sideEffects === true;
}

/**
 * Whether this function can serve as a keep-checking check (EO-456).
 *
 * False for an action nothing declares, for `builtinHasSideEffects`'
 * reason: a step naming a function this installation does not have is
 * already refused for that.
 */
export function builtinCanWait(registry: RegistryFacts, action: string | null): boolean {
  return action !== null && registry.builtins.get(action)?.watch === true;
}

/**
 * Whether this function opens a pull request (EO-663). False for an
 * action nothing declares, for `builtinHasSideEffects`' reason.
 */
export function builtinOpensPullRequest(registry: RegistryFacts, action: string | null): boolean {
  return action !== null && registry.builtins.get(action)?.opensPullRequest === true;
}

/**
 * Whether this agent keeps one provider thread per item (EO-86).
 *
 * **On a role the registry knows, the role decides and `config` is not
 * consulted** (EO-178). There is nothing left for a person to choose, so
 * the editor draws no checkbox for these — and this function has to agree
 * with that absence, or dispatch would go on acting on a key nobody can
 * see. The migration that came with EO-178 makes the stored configs say
 * the same thing, so the row and the behaviour match for whoever reads
 * the database next; this is what holds if somebody writes the key back
 * afterwards, which `agents.config` being an open bag means they can.
 *
 * **`action` is part of the question for a `per-conversation` role**
 * (EO-210), and omitting it answers "no" rather than guessing. That is
 * the safe direction: a caller that does not know what it is dispatching
 * gets the behaviour EO had before this existed — a fresh thread and a
 * full assembly — rather than a work item's unrelated dispatches
 * quietly sharing one conversation. The renderer omits it for exactly
 * that reason: it is drawing a checkbox for an agent, not dispatching a
 * run, and there is no action to speak of.
 *
 * A role answering `true` or `false` ignores it. Its answer is about the
 * shape of its runs rather than about what any one run was asked for,
 * and `implementer: true` surviving a review bounce, a clarification and
 * a direct mention alike is the whole of EO-86.
 *
 * On any other role the switch is still a person's, held in
 * `agents.config` rather than in a column of its own, which is where an
 * agent's options already live — `agents:save` takes an open record, so
 * the setting crosses IPC and reaches MCP `agent_save` without either
 * contract changing.
 *
 * `=== true` and nothing looser. `config` is an open bag written by the
 * editor, by MCP and by whoever opens the database, so a missing key, a
 * null, a `0` and the string `"false"` all genuinely arrive here — and
 * every one of them means the same thing as never having ticked the box.
 * Reusing a thread is the surprising behaviour of the two (an agent that
 * remembers, and that will not see edited instructions until its item
 * is done), so it takes a literal `true` to turn on and anything else
 * reads as off.
 *
 * **What reuse costs, wherever it is on.** A provider session keeps the
 * instructions it was started with — neither backend re-sends them on
 * resume — so an edit reaches a thread already open on the next *new*
 * thread rather than on the next message of the old one. What stops that
 * being a silent staleness is `findReusableThread`: it refuses a
 * candidate whose `instructions_hash` no longer matches, so the next
 * dispatch opens that new thread rather than carrying the old one. The
 * edit therefore lands immediately and the conversation is what it costs
 * — in a room that is the chat itself, ended the way Clear ends one, and
 * said out loud in a comment rather than discovered. `system-agent.md`
 * spells this out where somebody editing that prompt will read it; the
 * checkbox in the Agents editor states the cost more coarsely, for the
 * roles that still have one.
 *
 * In `packages/core` for the reason `summarizeInstructions` is: the
 * editor that draws this switch and the main process that acts on it
 * must not be able to disagree about what it says. The registry is a
 * parameter for the same reason — both hand it the one they were given,
 * and the renderer's is the main process's over `registry:get`.
 */
export function reusesThreadPerItem(registry: RegistryFacts, agent: Pick<Agent, "role" | "config">, action?: string | null): boolean {
  const role = registry.roles.get(agent.role);
  if (role !== undefined) {
    return role.threadReuse === PER_CONVERSATION ? isThreadPerConversationAction(action) : role.threadReuse;
  }
  return agent.config["reuseThreadPerItem"] === true;
}

/**
 * The schema a role in this registry declares for `action`, or undefined
 * when none does. By action across every role — see `RoleEntry.schemasByAction`
 * for why the role is not part of the question.
 */
export function schemaByAction(registry: Registry, action: string): OutputSchema | undefined {
  for (const role of registry.roles.values()) {
    const schema = role.schemasByAction.get(action);
    if (schema !== undefined) return schema;
  }
  return undefined;
}

/**
 * This role's own definition of `action`, or undefined when it has none
 * (EO-421).
 *
 * The first question every lookup of an action's shape asks, and the
 * only one that has a role in it. **Never another role's**: a
 * definition is a thing somebody wrote about one role, and answering
 * with it for a second would be the by-action lookup this replaced for
 * custom actions, under a new name.
 *
 * Undefined without a role, so a caller with no agent in hand falls
 * through to the by-action answer rather than borrowing a definition.
 */
export function definedActionFor(registry: Registry, role: string | null | undefined, action: string): DefinedAction | undefined {
  if (role === null || role === undefined) return undefined;
  return registry.actionDefinitions?.get(role)?.get(action);
}

/**
 * Whether the pack's meaning of this action name is in force for this
 * role (EO-422).
 *
 * A pack attaches behaviour to an action by its name: the developer
 * pack reads a verdict off a `review`, posts review feedback, appends
 * the pull-request request to the task, verifies an `implement` against
 * its branch and attaches the diff, and asks an `implement` to plan
 * first. All of that is what the *pack* means by the word. A role that
 * defines the action for itself means something else by it — role plus
 * action always wins — and then none of it applies: the run is the
 * role's, with the schema generated from its definition, the route its
 * `result` names and its `summary` as the handoff.
 *
 * **The one question, asked by every site that acts on an action's
 * name.** Before this each site compared the name alone, so a `qa` role
 * defining `review` was sent its own schema and then had a reviewer's
 * verdict read out of an answer that had none. One predicate rather
 * than a comparison per site, so the schema sent and the behaviour
 * applied cannot disagree about whose action it was.
 *
 * True without a role — a builtin or a module has none, and a caller
 * with no agent in hand is asking about the action by name, which is
 * the pack's. True for a role with no definition of its own, which is
 * the whole of EO-421's fall-through: a custom role on a `review` step
 * that defined nothing gets the pack's review in full.
 *
 * This package is where it lives; `packages/engine` is handed the
 * answer (`AssembleContextInput.packAction`) rather than a registry to
 * ask.
 */
export function packActionInForce(registry: Registry, role: string | null | undefined, action: string): boolean {
  return definedActionFor(registry, role, action) === undefined;
}

/**
 * Whether this role is one a pack ships, answering an action that pack
 * ships for it — the `reviewer`'s `review`, the `implementer`'s
 * `implement`, anything of the `system` role's (EO-422).
 *
 * A question about the **pair**: a custom role may define its own
 * `review`, and so may the `implementer`, since neither ships it. Only
 * the role that ships the action may not redefine it, because the pack
 * is already what holds that role to that shape — a definition beside
 * it would be a second answer to a question the pack has answered, and
 * the shipped role's posters, verification and prompt all read the
 * pack's.
 */
export function roleShipsAction(registry: Registry, role: string, action: string): boolean {
  return registry.roles.get(role)?.schemasByAction.has(action) === true;
}

/**
 * A registry's role-defined actions as facts: the same definitions, short
 * of their schemas (EO-423).
 *
 * What `RegistryOf.roleActions` is filled from, wherever the definitions
 * are in hand, so the two members of one registry cannot say different
 * things about a role.
 */
export function roleActionFactsOf(definitions: ActionDefinitions): RoleActionFacts {
  const byRole = new Map<string, Map<string, ActionFacts>>();
  for (const [role, actions] of definitions) {
    const facts = new Map<string, ActionFacts>();
    for (const [action, { definition }] of actions) {
      facts.set(action, {
        description: definition.description,
        results: definition.results.map((result) => ({ key: result.key, label: result.label, meaning: result.meaning })),
        packShipped: false,
        fields: definition.fields,
      });
    }
    byRole.set(role, facts);
  }
  return byRole;
}

/**
 * What `action` is when `role` is dispatched on it, or undefined when
 * nothing defines it (EO-423).
 *
 * The same order a dispatch resolves a schema in (EO-421): the role's own
 * definition first, and otherwise the installed pack's action of that
 * name, whichever role ships it — a custom role on an `implement` step
 * is held to the pack's implement. Never another role's definition.
 *
 * Typed on the facts, so the renderer and the main process ask one
 * function and cannot disagree about which keys a step must route.
 * Undefined is a real answer: an action nobody declared returns prose,
 * and its run routes as `done`.
 */
export function actionFactsFor(registry: RegistryFacts, role: string | null | undefined, action: string): ActionFacts | undefined {
  if (role !== null && role !== undefined) {
    const own = registry.roleActions?.get(role)?.get(action) ?? registry.roles.get(role)?.actions?.get(action);
    if (own !== undefined) return own;
  }
  for (const entry of registry.roles.values()) {
    const shipped = entry.actions?.get(action);
    if (shipped !== undefined) return shipped;
  }
  return undefined;
}

/**
 * Every action `role` can be dispatched on, each with what it resolves to
 * (EO-428).
 *
 * `actionFactsFor` asked the other way round — not "what is this action
 * for this role" but "which actions would that question answer" — and in
 * the same order, so the two cannot disagree: the role's own definitions
 * first, then what the pack ships for it, then every other pack action,
 * which a role that defined nothing of that name falls back to. A name
 * the role defined for itself is listed once, as the role's.
 *
 * Never an action only another role defined: a definition applies to its
 * own role and no other, so offering it here would be offering something
 * that resolves to nothing once picked.
 */
export function actionsAvailableTo(registry: RegistryFacts, role: string | null | undefined): { action: string; facts: ActionFacts }[] {
  const available = new Map<string, ActionFacts>();
  const offer = (actions: ReadonlyMap<string, ActionFacts> | undefined) => {
    for (const [action, facts] of actions ?? []) if (!available.has(action)) available.set(action, facts);
  };
  if (role !== null && role !== undefined) {
    offer(registry.roleActions?.get(role));
    offer(registry.roles.get(role)?.actions);
  }
  for (const entry of registry.roles.values()) offer(entry.actions);
  return [...available].map(([action, facts]) => ({ action, facts }));
}

/**
 * What the registry knows about the type a run is against: whether it
 * holds other items, and what it says its actions mean.
 *
 * A shape rather than the whole `ItemTypeEntry`, so that the row a
 * caller has in hand and the entry a pack declares are both one — the
 * `item_types` row is a superset of it, and nothing here needs a label
 * or a spec shape. `undefined` where a caller has no item — a schema
 * asked for by action alone, an editor drawing a shape — and the answer
 * is then the action's own, never a type's opinion of it.
 */
export type ActionSubject = Pick<ItemTypeEntry, "container" | "actionOverrides">;

/**
 * What a type nobody can find answers to (KAN-163).
 *
 * A leaf that overrides nothing, so it inherits the leaf defaults —
 * which is the conservative direction and the one the missing container
 * flag already took: work that arrived already written is checked, and
 * nothing invents a plan for an item whose type row went missing.
 * Named once so the two callers that can be handed a deleted row — the
 * supervisor and the prompt assembly — cannot answer it differently.
 */
export const UNKNOWN_ITEM_TYPE: ActionSubject = Object.freeze({ container: false, actionOverrides: Object.freeze({}) });

/** What a role says an action means by default, or undefined when none says. By action across every role, like `schemaByAction`. */
export function actionDefaultsFor(registry: Registry, action: string): ActionDefaults | undefined {
  for (const role of registry.roles.values()) {
    const defaults = role.actionDefaults?.get(action);
    if (defaults !== undefined) return defaults;
  }
  return undefined;
}

/**
 * What this action means on this type: the schema its result is held to,
 * the result key it reports and the poster that writes the record of it
 * (KAN-163, ARCHITECTURE.md, "An item type is data").
 *
 * The type's own override first, then the default the role that ships
 * the action declared for this kind of type. Undefined is the ordinary
 * answer — most actions mean one thing everywhere, and a caller reading
 * undefined uses the action's own schema and the step's own result key,
 * exactly as it did before overrides existed.
 *
 * `Object.hasOwn` rather than a bare index, because the overrides come
 * off a JSON column as a plain object and `constructor` is a word
 * somebody may name an action: an inherited property answered as an
 * override would be a shape nobody wrote.
 */
export function actionOverrideFor(registry: Registry, action: string, type?: ActionSubject): ActionOverride | undefined {
  if (type === undefined) return undefined;
  if (Object.hasOwn(type.actionOverrides, action)) return type.actionOverrides[action];
  const defaults = actionDefaultsFor(registry, action);
  if (defaults === undefined) return undefined;
  return type.container ? defaults.container : defaults.leaf;
}

/**
 * The name of the schema a result is held to — the override's, or the
 * action's own where nothing overrides it.
 *
 * What `resultSchemaFor` resolves and what the supervisor asks when it
 * needs to know *which* answer it is holding rather than what shape that
 * answer is: a decomposition's children get a graph check and a
 * clarification has no graph to check.
 *
 * The action's own name where the dispatched role defines it (EO-421):
 * that answer is the role's shape, and no type's override names it.
 */
export function actionSchemaName(registry: Registry, action: string, type?: ActionSubject, role?: string | null): string {
  if (definedActionFor(registry, role, action) !== undefined) return action;
  return actionOverrideFor(registry, action, type)?.schema ?? action;
}

/**
 * Everything this type says about every action, its own overrides in
 * front of the roles' defaults.
 *
 * For a reader that has to carry the answers somewhere rather than ask
 * for one — the prompt assembly hands the item to sections a pack wrote,
 * and a renderer holding a registry would be a renderer deciding what a
 * run answers in.
 *
 * A `Map` rather than the record the row holds, for the reason the
 * registry is maps throughout: these keys are action names somebody
 * chose.
 */
export function actionOverridesFor(registry: Registry, type?: ActionSubject): ReadonlyMap<string, ActionOverride> {
  if (type === undefined) return new Map();
  const actions = new Set([...Object.keys(type.actionOverrides), ...[...registry.roles.values()].flatMap((role) => [...(role.actionDefaults?.keys() ?? [])])]);
  const resolved = new Map<string, ActionOverride>();
  for (const action of actions) {
    const override = actionOverrideFor(registry, action, type);
    if (override !== undefined) resolved.set(action, override);
  }
  return resolved;
}

/** One override a pack declared, and what to call the thing that declared it when refusing to load it. */
export interface DeclaredActionOverride {
  /** `The "developer:story" item type`, `The "system" role's default for a container` — how a refusal names it. */
  declaredBy: string;
  action: string;
  override: ActionOverride;
}

/**
 * Every override and every default in a registry, with who declared
 * each.
 *
 * One walk, used by the two checks that have to agree about what an
 * override is: `buildRegistry` resolves the schema each names, and the
 * pack fold resolves the poster. Neither can be done in the other's
 * place — a schema is registry data and a poster is a function a pack
 * holds — so the walk is shared rather than the check.
 */
export function declaredActionOverrides(registry: Registry): DeclaredActionOverride[] {
  const declared: DeclaredActionOverride[] = [];
  for (const [key, type] of registry.itemTypes) {
    for (const [action, override] of Object.entries(type.actionOverrides)) declared.push({ declaredBy: `The "${key}" item type`, action, override });
  }
  for (const [slug, role] of registry.roles) {
    for (const [action, defaults] of role.actionDefaults ?? []) {
      declared.push({ declaredBy: `The "${slug}" role's default for a container`, action, override: defaults.container });
      declared.push({ declaredBy: `The "${slug}" role's default for a leaf`, action, override: defaults.leaf });
    }
  }
  return declared;
}

// ── Building one ────────────────────────────────────────────────

/**
 * The result a step reports when its function did not do its work.
 *
 * Named once rather than spelled in each of the places that need it —
 * every builtin's declaration, the supervisor's failure path, the
 * shipped pipeline's routes, and the editor. It is an ordinary result
 * key with no special meaning to routing: what makes it a failure is
 * that the runner refused, not that the string reads this way.
 */
export const FAILED_RESULT = "failed";

/**
 * The result a step reports when the work was done and the workspace
 * would not vouch for it (EO-297, invariant 5).
 *
 * Distinct from `FAILED_RESULT`, and the distinction is the whole point:
 * `failed` is the runner saying it could not do its work, and this is
 * the runner saying it did while a check of the workspace it worked in
 * disagreed. The two lead different places — one back to whoever
 * configured the step, one back to whoever did the work — so a pipeline
 * that wants to route them apart must be able to name them apart.
 *
 * Declared by nothing that runs. It is contributed by the *workspace
 * kind*, which is why no builtin lists it and no manifest can: whether a
 * step can report it depends on whether the kind the item's workspace
 * names has a verifier for that step's action. When no route declares
 * it, a failed check parks the item and asks, exactly as it did before
 * this key existed.
 */
export const VERIFICATION_FAILED_RESULT = "verification_failed";

/** The result a run reports when it cannot go on without a person's answer. The engine's own, like the two beside it. */
export const NEEDS_USER_INPUT_RESULT = "needs_user_input";

/** The result a run reports when it gave up and handed the item to a person (invariant 9). */
export const ESCALATION_RESULT = "escalation";

/**
 * The results a step may route without its action declaring them
 * (EO-423).
 *
 * Each is produced by EO rather than chosen by whatever ran: a run that
 * stopped to ask, a run that escalated, a workspace that would not vouch
 * for the work. So a route on one is never a branch that cannot be
 * taken, whatever the action's own list says — and none is required,
 * since where nothing routes it the item parks and asks.
 */
export const ENGINE_RESULTS: readonly string[] = [NEEDS_USER_INPUT_RESULT, ESCALATION_RESULT, VERIFICATION_FAILED_RESULT];

/**
 * Checks a registry's contents and returns it, or throws on the first
 * thing a pack got wrong.
 *
 * Throwing is right here and nowhere else in this file: a registry is
 * built once at startup from what is installed, so a broken one is a
 * programmer error in a pack, found on the first launch that includes
 * it — not a condition a running installation meets and has to say
 * something about. The message names the entry so the pack author is
 * sent to the line.
 *
 * Two rules. Every builtin declares at least one result and `failed`
 * among them, because a function whose failure has no name is one whose
 * failure nothing can route (EO-77). And no two roles declare a schema
 * for the same action, because `resultSchemaFor` answers by action alone
 * and would otherwise answer with whichever role happened to be
 * registered first — the import-order fact a registry exists to remove.
 */
export function buildRegistry(registry: Registry): Registry {
  for (const [action, { label, results, inputs }] of registry.builtins) {
    // Named (EO-507): the editor's picker offers a function by this, and
    // an empty option is one nobody can tell from the next.
    if (label.trim() === "") throw new Error(`Builtin "${action}" declares no label, so the editor would offer it as a blank.`);
    for (const [name, input] of Object.entries(inputs ?? {})) {
      if (name.trim() === "") throw new Error(`Builtin "${action}" declares an input with no name.`);
      if (input.description.trim() === "") throw new Error(`Builtin "${action}"'s "${name}" input has no description, so the editor could not say what goes in it.`);
      if (input.default !== undefined && typeof input.default !== input.type) {
        throw new Error(`Builtin "${action}"'s "${name}" input is declared a ${input.type} with a default that is not one.`);
      }
    }
    if (results.length === 0) throw new Error(`Builtin "${action}" declares no results; it needs at least "${FAILED_RESULT}".`);
    if (!results.includes(FAILED_RESULT)) throw new Error(`Builtin "${action}" does not declare "${FAILED_RESULT}", so a pipeline could not route its failure.`);
    // Reserved (EO-456): a check says `waiting` while it waits, and a key
    // that also routed would be a check that could never say so.
    if (results.includes(WAITING_RESULT)) throw new Error(`Builtin "${action}" declares "${WAITING_RESULT}" as a result, but that is what a check says while it is still waiting and it never routes.`);
  }

  const declaredBy = new Map<string, string>();
  for (const [slug, role] of registry.roles) {
    for (const action of role.schemasByAction.keys()) {
      const other = declaredBy.get(action);
      if (other !== undefined) throw new Error(`Roles "${other}" and "${slug}" both declare a schema for "${action}"; a result is validated by action, so only one may.`);
      declaredBy.set(action, slug);
    }
  }

  // An action a pack ships says what it can return (EO-423): a step
  // dispatching it is held to routing every one of its results, and an
  // action with none would be one no step could satisfy or fail.
  for (const [slug, role] of registry.roles) {
    for (const [action, facts] of role.actions ?? []) {
      if (facts.results.length === 0) throw new Error(`The "${slug}" role's "${action}" action declares no results; a step running it would have nothing to route.`);
    }
  }

  // An item type's key *is* its identity — the pair `item_types` is
  // unique on, minus the project. A key that disagrees with the entry
  // under it would be a type that seeds as one thing and is looked up as
  // another, and the two would only diverge once a second pack existed
  // to notice.
  for (const [key, type] of registry.itemTypes) {
    const expected = qualifiedItemType(type);
    if (key !== expected) throw new Error(`Item type "${key}" is filed under a key its own pack and slug do not make: "${expected}".`);
  }

  // And an override names a schema somebody registered (KAN-163). An
  // override is data, and data naming a shape nothing can resolve is
  // data that only looks like data: the run would be held to no shape at
  // all, silently, and the first sign of it would be a malformed result
  // reaching the thread. The poster half is checked where the packs are
  // folded, which is the first moment both halves are in one hand.
  for (const { declaredBy, action, override } of declaredActionOverrides(registry)) {
    if (schemaByAction(registry, override.schema) === undefined) {
      throw new Error(`${declaredBy} says "${action}" is answered in the "${override.schema}" shape, but no role in this registry declares a schema by that name.`);
    }
  }

  return registry;
}

/** A registry with nothing in it — what the renderer holds until `registry:get` answers, and what the core builds to without a pack. */
export function emptyRegistry(): Registry {
  return { roles: new Map(), builtins: new Map(), itemTypes: new Map(), packs: new Map() };
}

// ── The wire form ───────────────────────────────────────────────

const ThreadReuseSchema = z.union([z.boolean(), z.literal(PER_CONVERSATION)]);

/**
 * `registry:get`'s answer: the registry short of its schemas, as arrays
 * (KAN-124).
 *
 * Arrays rather than the maps the in-process form uses, because this is
 * the one shape that survives every transport the contract crosses —
 * Electron's structured clone would carry a `Map`, the MCP host's JSON
 * would not, and a channel that answers differently by transport is a
 * channel with two contracts. `fromRegistryView` turns it back into the
 * maps every lookup takes.
 */
/**
 * A type's action overrides, wherever they cross a boundary — the same
 * two `SpecShapeSchema` crosses, and one more: these decide what a run's
 * result is held to (KAN-163), so a malformed document is something to
 * reject rather than to act on.
 */
export const ActionOverridesSchema = z.record(
  z.string().min(1),
  z.object({ schema: z.string().min(1), resultKey: z.string().min(1), poster: z.string().min(1) }),
);

/**
 * One action on the wire (EO-423): its name, what it is for, the results
 * it can return with their labels, and whether a pack ships it.
 */
/**
 * One pipeline step that dispatches an action (EO-425): what a reader is
 * told before changing a definition, and what a delete is refused with.
 */
export const ActionUseSchema = z.object({
  pipelineId: z.string(),
  pipelineName: z.string(),
  stepId: z.string(),
  stepName: z.string(),
  /**
   * Set when the use is not in the pipeline's current graph: the older
   * version that still defines the step this way, and how many
   * unfinished items are bound to it. An item finishes on the version it
   * entered on, so that step can still be dispatched for them — after a
   * publish removed it, or gave it another owner or action. Absent for a
   * step of the graph as it stands.
   */
  finishing: z.object({ version: z.number(), items: z.number() }).optional(),
});

export type ActionUse = z.infer<typeof ActionUseSchema>;

/**
 * A use, with the result keys that step routes on (EO-427).
 *
 * What a change of an action's result keys is weighed against: a step
 * using the action must route every declared key and may route no other
 * (EO-423). For a use an older version holds, these are that version's
 * routes — the ones the items still bound to it are carried by.
 */
export const ActionRouteUseSchema = ActionUseSchema.extend({ routedKeys: z.array(z.string()) });

export type ActionRouteUse = z.infer<typeof ActionRouteUseSchema>;

const ActionFactsViewSchema = z.object({
  action: z.string().min(1),
  description: z.string(),
  /** `meaning` is a role's own definition's (EO-425); a pack's action has none on the wire. */
  results: z.array(z.object({ key: z.string().min(1), label: z.string(), meaning: z.string().optional() })),
  packShipped: z.boolean(),
  /** The definition's extra answer properties, as a JSON Schema (EO-425). Absent on a pack's action. */
  fields: z.record(z.string(), z.unknown()).optional(),
  /**
   * The agent steps owned by this role that dispatch this action, in
   * every live pipeline (EO-425). Filled by `registry:get`'s handler,
   * which is the one place holding both the registry and the pipelines;
   * a view built from a registry alone leaves it out.
   */
  usedBy: z.array(ActionUseSchema).optional(),
});

type ActionFactsView = z.infer<typeof ActionFactsViewSchema>;

export const RegistryViewSchema = z.object({
  roles: z.array(
    z.object({
      slug: z.string().min(1),
      prompt: z.string(),
      threadReuse: ThreadReuseSchema,
      /** The actions the pack ships for this role (EO-423). Optional for `packs`' reason — the renderer does not parse this. */
      actions: z.array(ActionFactsViewSchema).optional(),
    }),
  ),
  /**
   * The actions roles define for themselves, by role (EO-423). Beside
   * `roles` rather than in it: that list is the roles a pack ships, and
   * a custom role appearing there would be marked built-in. Optional for
   * `packs`' reason.
   */
  roleActions: z.array(z.object({ role: z.string().min(1), actions: z.array(ActionFactsViewSchema) })).optional(),
  builtins: z.array(
    z.object({
      action: z.string().min(1),
      /** What the editor calls it (EO-507). */
      label: z.string().min(1),
      results: z.array(z.string().min(1)).min(1),
      /** What a step running it can set (EO-507). Optional for `sideEffects`' reason, and absent is none. */
      inputs: z
        .record(
          z.string().min(1),
          z.object({ type: z.enum(["string", "number", "boolean"]), description: z.string().min(1), default: z.union([z.string(), z.number(), z.boolean()]).optional() }),
        )
        .optional(),
      /** Whether running it reaches outside EO (EO-334). Optional for `packs`' reason — the renderer does not parse this. */
      sideEffects: z.boolean().optional(),
      /** Whether it can serve as a keep-checking check (EO-456). Optional for `sideEffects`' reason. */
      watch: z.boolean().optional(),
      /** Whether it opens a pull request (EO-663). Optional for `sideEffects`' reason. */
      opensPullRequest: z.boolean().optional(),
    }),
  ),
  itemTypes: z.array(
    z.object({
      packSlug: z.string().min(1),
      slug: z.string().min(1),
      label: z.string().min(1),
      plural: z.string().min(1),
      container: z.boolean(),
      specShape: SpecShapeSchema,
      actionOverrides: ActionOverridesSchema,
    }),
  ),
  /**
   * The packs' own words (EO-309). An array for the reason the rest of
   * this document is one: a `Map` does not survive every transport the
   * contract crosses.
   */
  packs: z
    .array(
      z.object({
        slug: z.string().min(1),
        item: z.string().min(1),
        items: z.string().min(1),
        results: z.record(z.string().min(1), z.string().min(1)),
      }),
    )
    // Optional rather than defaulted, because the renderer does not
    // parse what comes back — `ipcQuery` unwraps the envelope and hands
    // the payload straight to `fromRegistryView`, so a default that only
    // exists inside `parse` would not be there when it mattered. An
    // absent vocabulary is a registry with no packs in it, which
    // `chromeVocabulary` answers for with the neutral word: the safe
    // answer rather than a crash on the way to a wrong one.
    .optional(),
  /** The entry rule kinds packs contribute (EO-610). Optional for `packs`' reason. */
  entryRuleKinds: z
    .array(z.object({ kind: z.string().min(1), noun: z.string().min(1), extension: z.string().min(1), property: z.string().min(1) }))
    .optional(),
});

export type RegistryView = z.infer<typeof RegistryViewSchema>;

function toActionViews(actions: ReadonlyMap<string, ActionFacts> | undefined): ActionFactsView[] {
  return [...(actions ?? [])].map(([action, facts]) => ({
    action,
    description: facts.description,
    // A key that is absent stays absent rather than arriving as
    // `undefined`: the channel's answer crosses JSON on one of its
    // transports, and the two must be the same document.
    results: facts.results.map((result) => ({ key: result.key, label: result.label, ...(result.meaning === undefined ? {} : { meaning: result.meaning }) })),
    packShipped: facts.packShipped,
    ...(facts.fields === undefined ? {} : { fields: { ...facts.fields } }),
  }));
}

function fromActionViews(views: readonly ActionFactsView[] | undefined): Map<string, ActionFacts> {
  return new Map(
    (views ?? []).map((view) => [
      view.action,
      { description: view.description, results: view.results, packShipped: view.packShipped, ...(view.fields === undefined ? {} : { fields: view.fields }) },
    ]),
  );
}

/** The registry as `registry:get` sends it. Schemas stay behind — see `RoleFacts`. */
export function toRegistryView(registry: RegistryFacts): RegistryView {
  return {
    roles: [...registry.roles].map(([slug, role]) => ({ slug, prompt: role.prompt, threadReuse: role.threadReuse, actions: toActionViews(role.actions) })),
    roleActions: [...(registry.roleActions ?? [])].map(([role, actions]) => ({ role, actions: toActionViews(actions) })),
    builtins: [...registry.builtins].map(([action, entry]) => ({
      action,
      label: entry.label,
      results: [...entry.results],
      ...(entry.inputs === undefined ? {} : { inputs: Object.fromEntries(Object.entries(entry.inputs).map(([name, input]) => [name, { ...input }])) }),
      sideEffects: entry.sideEffects,
      ...(entry.watch === true ? { watch: true } : {}),
      ...(entry.opensPullRequest === true ? { opensPullRequest: true } : {}),
    })),
    itemTypes: [...registry.itemTypes.values()].map((type) => ({
      packSlug: type.packSlug,
      slug: type.slug,
      label: type.label,
      plural: type.plural,
      container: type.container,
      specShape: type.specShape,
      actionOverrides: { ...type.actionOverrides },
    })),
    packs: [...registry.packs].map(([slug, vocabulary]) => ({
      slug,
      item: vocabulary.item,
      items: vocabulary.items,
      results: { ...vocabulary.results },
    })),
    entryRuleKinds: [...(registry.entryRuleKinds ?? [])].map(([kind, entry]) => ({ kind, ...entry })),
  };
}

/** The registry as the renderer holds it, built from what `registry:get` answered. */
export function fromRegistryView(view: RegistryView): RegistryFacts {
  return {
    roles: new Map(view.roles.map((role) => [role.slug, { prompt: role.prompt, threadReuse: role.threadReuse, actions: fromActionViews(role.actions) }])),
    roleActions: new Map((view.roleActions ?? []).map((entry) => [entry.role, fromActionViews(entry.actions)])),
    // `=== true` rather than carried through, because the field is
    // optional on the wire — a view written before this existed, or by
    // something that does not send it, answers no rather than undefined.
    builtins: new Map(
      view.builtins.map((builtin) => [
        builtin.action,
        {
          label: builtin.label,
          results: builtin.results,
          ...(builtin.inputs === undefined ? {} : { inputs: builtin.inputs }),
          sideEffects: builtin.sideEffects === true,
          ...(builtin.watch === true ? { watch: true } : {}),
          ...(builtin.opensPullRequest === true ? { opensPullRequest: true } : {}),
        },
      ]),
    ),
    itemTypes: new Map(view.itemTypes.map((type) => [qualifiedItemType(type), type])),
    packs: new Map((view.packs ?? []).map((pack) => [pack.slug, { item: pack.item, items: pack.items, results: pack.results }])),
    entryRuleKinds: new Map((view.entryRuleKinds ?? []).map(({ kind, ...entry }) => [kind, entry])),
  };
}
