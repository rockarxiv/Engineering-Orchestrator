import {
  actionDefinitionOutputSchema,
  developerRegistry,
  isUndispatchedAction,
  packActionInForce,
  ProposedActionsSchema,
  proposedActionDraft,
  readActionDefinitionDraft,
  roleActionFactsOf,
  roleShipsAction,
  type ActionDefinition,
  type ActionDefinitionDraft,
  type ActionDefinitions,
  type DefinedAction,
  type Item,
  type OutputSchema,
  type Registry,
  type Uuid,
} from "@eo/core";
import type { Db } from "./db/client.js";
import { listActionDefinitions } from "./db/repos/actionDefinitionsRepo.js";
import { itemTypesFor } from "./db/repos/itemTypesRepo.js";

/**
 * The registry in force for this process (KAN-124).
 *
 * What roles, built-in functions and item types this installation
 * knows about, handed to every lookup that used to read a constant of
 * its own: the validator, the schema lookups, thread reuse, the Agents
 * editor's built-in marking, and `registry:get` for the renderer.
 *
 * A module-level value for the reason `promptsDir` is: it is a property
 * of the running app rather than of any one call, and every reader
 * wants the same answer.
 *
 * **What is in it is decided by `createEngine`** (KAN-144), which folds
 * the installed packs and calls `useRegistry` with the result before it
 * builds a supervisor. The value below is what a process that never
 * composes an engine reads — a test of a single lookup, an IPC handler
 * exercised on its own — and it is the developer pack's contribution
 * because that is the installation EO ships. A second pack changes the
 * fold, not this line.
 */
let current: Registry = developerRegistry();

/**
 * Installed once, by the composition root, from whatever packs it
 * folded.
 *
 * A setter rather than a parameter on each lookup because the readers
 * are IPC handlers, prompt loading and the supervisor's own validation,
 * and threading a registry through every one of them would put an
 * argument on functions that have no other reason to know a registry
 * exists — with one caller forgetting it answering for a different set
 * of packs than the one the engine is running. Called before anything
 * ticks, and never again.
 */
export function useRegistry(next: Registry): void {
  current = next;
}

/**
 * The registry itself.
 *
 * A getter rather than a `const`, so a reader that imported this module
 * before the fold ran still sees what the fold installed. A snapshot
 * taken at import time would be a property of module order, which is
 * the fact a registry exists to remove.
 */
export const registry: Registry = {
  get roles() {
    return current.roles;
  },
  get builtins() {
    return current.builtins;
  },
  /**
   * What the installed packs *ship* — the seed, not the answer.
   *
   * Item types became rows scoped to a project in KAN-129, so the
   * question "what types are there" has a project in it and this
   * property cannot answer it. It is what `syncItemTypes` writes into
   * the table at startup, and what a reader with no project in hand
   * still sees. Anything holding an item, or a project, asks
   * `registryForProject`.
   */
  get itemTypes() {
    return current.itemTypes;
  },
  /** What each installed pack calls its own work (EO-309). Code a pack contributes, like its roles. */
  get packs() {
    return current.packs;
  },
  /** The entry rule kinds packs contribute (EO-610). Code, like the roles, so one project sees what another does. */
  get entryRuleKinds() {
    return current.entryRuleKinds ?? new Map();
  },
};

/**
 * The registry as one project sees it (KAN-129, EO-314).
 *
 * Builtins and roles are the installation's and are the same on every
 * project — they are code a pack contributes. Item types are data, and
 * `item_types` holds a row per project, so this is where the two meet:
 * the folded packs' builtins and roles, the types this project actually
 * has, and the actions roles on this installation define for themselves
 * (EO-421).
 *
 * `null` means the installation scope, which is what an item written
 * before any repository was attached belongs to.
 *
 * This is the registry every schema question is answered from — the
 * supervisor resolves an action's provider schema and validates the
 * result against it through `registryFor(item)`, which is this — so it
 * is where a role's own definition of an action has to appear, or it is
 * a row nothing reads.
 */
export function registryForProject(db: Db, projectId: Uuid | null): Registry {
  const actionDefinitions = definedActions(db);
  return {
    roles: current.roles,
    builtins: current.builtins,
    itemTypes: itemTypesFor(db, projectId),
    packs: current.packs,
    ...(current.entryRuleKinds === undefined ? {} : { entryRuleKinds: current.entryRuleKinds }),
    actionDefinitions,
    // The same definitions short of their schemas (EO-423): what
    // `validatePipeline` holds an agent step's routes to, and what
    // `registry:get` sends so the renderer's validator is told the same.
    roleActions: roleActionFactsOf(actionDefinitions),
  };
}

/**
 * The actions roles define for themselves, each with the schema
 * generated from it (EO-421).
 *
 * This replaced `dataPackRoles`, which read `agents.config.schemasByAction`
 * and filed what it found as a *role entry* — so an imported role's
 * schema answered for that action on every role, by the by-action lookup
 * a pack's shipped schemas use. A definition is keyed by its role and
 * never leaves it, which is why it is a member of its own rather than
 * another entry in `roles`.
 *
 * Read from the table on every call rather than folded once, for the
 * reason the item types are: a definition can be saved while the app is
 * running, and `useRegistry` is deliberately a one-shot the composition
 * root owns.
 *
 * **A definition that cannot be used is skipped, not thrown.** The save
 * refuses fields ajv cannot compile, a definition with no results, an
 * action no step dispatches and a pack's own role redefining its own
 * action, so
 * reaching one here takes a hand-edited database — and a registry that
 * throws is a supervisor that cannot dispatch anything at all. The role
 * is then answered as one with no definition of its own.
 */
function definedActions(db: Db): ActionDefinitions {
  const byRole = new Map<string, Map<string, DefinedAction>>();

  for (const definition of listActionDefinitions(db)) {
    if (definition.results.length === 0) continue;
    // The two pairs the save refuses (EO-422), refused here as well for
    // a row that did not come through it. An action EO runs for itself
    // has its answer read by EO's own code, and a pack's own role on its
    // own action is held to the pack's shape — a row saying otherwise is
    // answered as no definition, exactly like one that will not compile.
    if (isUndispatchedAction(definition.action) || installedRoleShips(definition.role, definition.action)) continue;
    const schema = compiledSchemaFor(definition);
    if (schema === null) continue;

    const ofRole = byRole.get(definition.role) ?? new Map<string, DefinedAction>();
    ofRole.set(definition.action, { definition, schema });
    byRole.set(definition.role, ofRole);
  }

  return byRole;
}

/** A proposed definition as the save would write it: checked, normalised, and not yet a row. */
export type ProposedDefinition = Pick<ActionDefinition, "role" | "action" | "description" | "results" | "fields">;

/** What `withProposedActions` answers: the registry as it would be, or why a proposal could not be written. */
export type ProposedActionsResult = { ok: true; registry: Registry; definitions: ProposedDefinition[] } | { ok: false; problems: string[] };

/**
 * A registry with the definitions a pipeline draft proposes laid over
 * the installation's own (EO-426).
 *
 * What a draft, and the publish of one, is validated against: the
 * installation as it will be once the person accepts the card. Without
 * it a draft introducing an action would be told its step's answer "is
 * not validated" — or, where it changes a definition, be held to the
 * keys it is replacing — and a card that cannot be judged as Publish
 * will judge it is the thing `validateDraft` exists to avoid.
 *
 * **Each proposal is put through the save's own rules first**
 * (`readActionDefinitionDraft`, told what the installed packs ship), so
 * nothing is laid over that the save would then refuse. The sentences
 * come back naming the role and the action, since they are read in a
 * thread with no form beside them.
 *
 * Nothing is written and nothing here is kept: the ids and times are
 * placeholders no row holds, there only because a definition has them.
 */
export function withProposedActions(base: Registry, proposed: readonly ActionDefinitionDraft[]): ProposedActionsResult {
  const problems: string[] = [];
  const definitions: ProposedDefinition[] = [];
  const byRole = new Map<string, Map<string, DefinedAction>>();
  for (const [role, actions] of base.actionDefinitions ?? []) byRole.set(role, new Map(actions));

  for (const draft of proposed) {
    const read = readActionDefinitionDraft(draft, { shipsAction: installedRoleShips });
    if (!read.ok) {
      problems.push(...read.problems.map((problem) => `${draft.role}'s "${draft.action}": ${problem}`));
      continue;
    }
    const definition: ActionDefinition = {
      id: `proposed:${read.role}:${read.action}`,
      role: read.role,
      action: read.action,
      description: read.description,
      results: read.results,
      fields: read.fields,
      createdAt: 0,
      updatedAt: 0,
    };
    const schema = compiledSchemaFor(definition);
    if (schema === null) {
      problems.push(`${read.role}'s "${read.action}": The fields are not a JSON Schema EO can read.`);
      continue;
    }
    const ofRole = byRole.get(read.role) ?? new Map<string, DefinedAction>();
    ofRole.set(read.action, { definition, schema });
    byRole.set(read.role, ofRole);
    definitions.push({ role: read.role, action: read.action, description: read.description, results: read.results, fields: read.fields });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, definitions, registry: { ...base, actionDefinitions: byRole, roleActions: roleActionFactsOf(byRole) } };
}

/**
 * What is wrong with the action definitions a `configure` or `assist`
 * reply proposes, as this installation's save would judge them — or
 * null where it would write every one (EO-426).
 *
 * The half of the save's rules a schema cannot ask. The reply's own
 * schema has already held each definition to everything that is about
 * the definition alone; whether its role is a pack's own and the action
 * one that pack ships for it is a fact about the registry in force,
 * which `packages/core` does not hold. So it is asked here, of a result
 * that has passed its schema, **where every result is validated** — and
 * a reply that fails it is sent back to the agent with the save's own
 * sentence, in the same run, as one that fails its schema is. Refusing
 * it later, when the card is drawn, would be telling the person rather
 * than the agent: the run has succeeded by then, and nothing corrects
 * the reply until somebody types again.
 *
 * `reply` is the validated result. A reply with no `actions`, or one
 * that is not this shape at all, has nothing to ask.
 */
export function proposedActionsProblem(registryInForce: Registry, reply: unknown): string | null {
  if (typeof reply !== "object" || reply === null) return null;
  const parsed = ProposedActionsSchema.safeParse((reply as { actions?: unknown }).actions ?? []);
  if (!parsed.success || parsed.data.length === 0) return null;

  const judged = withProposedActions(registryInForce, parsed.data.map(proposedActionDraft));
  if (judged.ok) return null;
  return [
    "An action definition in `actions` cannot be saved on this installation, so the draft was not offered:",
    ...judged.problems.map((problem) => `- ${problem}`),
    "Nothing was written. Fix or remove that entry — a step can simply name an action that already exists — and return the draft again.",
  ].join("\n");
}

/**
 * The compiled schemas, by what they were compiled from.
 *
 * `registryForProject` is asked several times per run and compiling a
 * document is the expensive half of it. Keyed on the two members the
 * schema is generated from rather than on the row's id and timestamp, so
 * a row edited by any route — the save, a restore, a hand — is compiled
 * again exactly when what it says changed.
 */
const compiled = new Map<string, OutputSchema | null>();
const COMPILED_LIMIT = 512;

function compiledSchemaFor(definition: ActionDefinition): OutputSchema | null {
  const key = JSON.stringify([definition.results.map((result) => result.key), definition.fields]);
  const held = compiled.get(key);
  if (held !== undefined) return held;

  let schema: OutputSchema | null;
  try {
    schema = actionDefinitionOutputSchema(definition);
  } catch {
    schema = null;
  }
  // A cache, not a record: emptied rather than trimmed when it has
  // outgrown any real installation, since what it holds is rebuilt on
  // the next ask.
  if (compiled.size >= COMPILED_LIMIT) compiled.clear();
  compiled.set(key, schema);
  return schema;
}

/**
 * Whether this is an installed pack's own role answering its own
 * shipped action — the `reviewer`'s `review`, the `implementer`'s
 * `implement`.
 *
 * What the adoption of a carried schema asks (`adoptCarriedSchemas`),
 * and deliberately a question about the **pair**: a definition is keyed
 * by role and action, so a custom role carrying a schema for `review`
 * has its own version of that action and it is written. Only the role
 * that ships the action is left out, because what it carries there is
 * the pack's own shape written down — the shipped pipeline's export
 * does exactly that — and the pack is already what holds it.
 */
export function installedRoleShips(role: string, action: string): boolean {
  return roleShipsAction(current, role, action);
}

/**
 * Whether the pack's meaning of `action` is in force for a run of it by
 * `role` on this item (EO-422) — `packActionInForce`, against the
 * registry this item's project sees.
 *
 * What every site that acts on an action's *name* asks before it does:
 * the developer pack's wiring before it reads a verdict or posts a
 * handoff, its review appendix, its git verifier and its diff, the
 * plan-mode and clarify sections, and the supervisor's own plan-mode
 * report. False means the dispatched role defined the action for itself
 * and the run is the role's.
 *
 * **A preview is always the pack's**, for `definingRole`'s reason in the
 * supervisor: it runs on the placeholder backend and is held to no
 * role's definition, so the schema it was sent is the by-action one and
 * the behaviour has to be the one that goes with that schema. One
 * function for both halves of that sentence, so they cannot come apart.
 *
 * `role` is null where there is no agent — a builtin, a module, a
 * caller asking about the action alone — and the answer is then yes.
 */
export function packMeaningInForce(db: Db, item: Pick<Item, "projectId" | "previewAt">, role: string | null | undefined, action: string): boolean {
  return packActionInForce(registryForProject(db, item.projectId), item.previewAt === null ? role : null, action);
}
